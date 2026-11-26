//! Narrow reuse of Iris Chat RS core/src/image_proxy.rs (MIT;
//! IRIS_CHAT_LICENSE.txt). Market deliberately has no direct fallback path.
use crate::{
    model::ImageProxySettings,
    profiles::{Person, Profile},
};
use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::sync::OnceLock;
use url::{Origin, Url};

pub const DEFAULT_URL: &str = "https://imgproxy.iris.to";
// Public client credentials shared with Iris Chat. These are not account keys.
const KEY: &str = "f66233cb160ea07078ff28099bfa3e3e654bc10aa4a745e12176c433d79b8996";
const SALT: &str = "5e608e60945dcd2a787e8465d76ba34149894765061d39287609fb9d776caa0c";

fn credentials() -> &'static ([u8; 32], [u8; 32]) {
    static CREDS: OnceLock<([u8; 32], [u8; 32])> = OnceLock::new();
    CREDS.get_or_init(|| {
        let decode = |input: &str| {
            let mut out = [0u8; 32];
            for (i, byte) in out.iter_mut().enumerate() {
                *byte = u8::from_str_radix(&input[i * 2..i * 2 + 2], 16).expect("valid hex");
            }
            out
        };
        (decode(KEY), decode(SALT))
    })
}

pub fn validate(settings: &ImageProxySettings) -> Result<()> {
    if !settings.enabled {
        return Ok(());
    }
    let url = Url::parse(settings.url.trim()).ok();
    ensure!(
        url.is_some_and(|url| url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()),
        "Use a secure image proxy address"
    );
    Ok(())
}

/// Pre-validated proxy configuration reused across all URLs in one snapshot.
enum Mode {
    Direct,
    Invalid,
    Proxy {
        base: String,
        origin: Origin,
        prefix: String,
    },
}
pub(crate) struct ProxySigner(Mode);
impl ProxySigner {
    pub(crate) fn new(settings: &ImageProxySettings) -> Self {
        if !settings.enabled {
            return Self(Mode::Direct);
        }
        if validate(settings).is_err() {
            return Self(Mode::Invalid);
        }
        let trimmed = settings.url.trim();
        let Ok(proxy) = Url::parse(trimmed) else {
            return Self(Mode::Invalid);
        };
        Self(Mode::Proxy {
            base: trimmed.trim_end_matches('/').to_owned(),
            prefix: proxy.path().trim_end_matches('/').to_owned(),
            origin: proxy.origin(),
        })
    }
    pub(crate) fn url(
        &self,
        source: &str,
        width: u32,
        height: u32,
        square: bool,
    ) -> Option<String> {
        if matches!(self.0, Mode::Invalid) {
            return None;
        }
        let source = source.trim();
        let original = Url::parse(source).ok()?;
        if !matches!(original.scheme(), "https" | "http") || original.host_str().is_none() {
            return None;
        }
        let Mode::Proxy {
            base,
            origin,
            prefix,
        } = &self.0
        else {
            return Some(source.into());
        };
        if origin == &original.origin()
            && (original.path() == prefix
                || original
                    .path()
                    .strip_prefix(prefix.as_str())
                    .is_some_and(|suffix| suffix.starts_with('/')))
        {
            return Some(source.into());
        }
        let mode = if square { "fill" } else { "fit" };
        let path = format!(
            "/rs:{mode}:{}:{}/dpr:2/{}",
            width.clamp(1, 2048),
            height.clamp(1, 2048),
            URL_SAFE_NO_PAD.encode(source.as_bytes())
        );
        let (key, salt) = credentials();
        let mut mac = Hmac::<Sha256>::new_from_slice(key).ok()?;
        mac.update(salt);
        mac.update(path.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        Some(format!("{base}/{signature}{path}"))
    }
    pub(crate) fn person(&self, person: &mut Person) {
        person.picture_url = person
            .picture_url
            .as_deref()
            .and_then(|url| self.url(url, 128, 128, true));
    }
    pub(crate) fn profile(&self, profile: &mut Profile) {
        self.person(&mut profile.person);
        for person_value in profile
            .following
            .iter_mut()
            .chain(profile.followers.iter_mut())
            .chain(profile.followed_by_known.iter_mut())
        {
            self.person(person_value);
        }
    }
}

pub fn image_url(
    source: &str,
    settings: &ImageProxySettings,
    width: u32,
    height: u32,
    square: bool,
) -> Option<String> {
    ProxySigner::new(settings).url(source, width, height, square)
}
pub fn person(person: &mut Person, settings: &ImageProxySettings) {
    ProxySigner::new(settings).person(person);
}
pub fn profile(profile: &mut Profile, settings: &ImageProxySettings) {
    ProxySigner::new(settings).profile(profile);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_signature_and_no_direct_fallback() {
        let settings = ImageProxySettings::default();
        assert_eq!(
            image_url("https://example.com/avatar.jpg", &settings, 64, 64, true).unwrap(),
            "https://imgproxy.iris.to/4fH1_iqEZLmDoPV6g4SieWBlKesgOOoKMpaHHGhHIMI/rs:fill:64:64/dpr:2/aHR0cHM6Ly9leGFtcGxlLmNvbS9hdmF0YXIuanBn"
        );
        let broken = ImageProxySettings {
            url: "file:///private/proxy".into(),
            ..settings.clone()
        };
        assert!(image_url("https://example.com/avatar.jpg", &broken, 64, 64, true).is_none());
        let direct = ImageProxySettings {
            enabled: false,
            ..settings
        };
        assert_eq!(
            image_url("https://example.com/avatar.jpg", &direct, 64, 64, true).as_deref(),
            Some("https://example.com/avatar.jpg")
        );
    }
    #[test]
    fn exact_origin_and_path_boundary_are_required() {
        let settings = ImageProxySettings {
            url: "https://images.example/proxy".into(),
            ..Default::default()
        };
        let existing = "https://images.example/proxy/signature/source";
        assert_eq!(
            image_url(existing, &settings, 64, 64, true).as_deref(),
            Some(existing)
        );
        for source in [
            "https://images.example/proxy-other/avatar.jpg",
            "https://images.example.attacker.test/proxy/avatar.jpg",
            "https://images.example@attacker.test/proxy/avatar.jpg",
        ] {
            let result = image_url(source, &settings, 64, 64, true).unwrap();
            assert_ne!(result, source);
            assert!(result.starts_with("https://images.example/proxy/"));
        }
        assert!(image_url("file:///private/avatar.jpg", &settings, 64, 64, true).is_none());
    }
}

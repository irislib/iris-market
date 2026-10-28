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
use url::Url;

pub const DEFAULT_URL: &str = "https://imgproxy.iris.to";
// Public client credentials shared with Iris Chat. These are not account keys.
const KEY: &str = "f66233cb160ea07078ff28099bfa3e3e654bc10aa4a745e12176c433d79b8996";
const SALT: &str = "5e608e60945dcd2a787e8465d76ba34149894765061d39287609fb9d776caa0c";

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
pub fn image_url(
    source: &str,
    settings: &ImageProxySettings,
    width: u32,
    height: u32,
    square: bool,
) -> Option<String> {
    let source = source.trim();
    let original = Url::parse(source).ok()?;
    if !matches!(original.scheme(), "https" | "http") || original.host_str().is_none() {
        return None;
    }
    if !settings.enabled {
        return Some(source.into());
    }
    validate(settings).ok()?;
    let proxy = Url::parse(settings.url.trim()).ok()?;
    let prefix = proxy.path().trim_end_matches('/');
    if original.origin() == proxy.origin()
        && (original.path() == prefix
            || original
                .path()
                .strip_prefix(prefix)
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
    let mut mac = Hmac::<Sha256>::new_from_slice(&decode_hex(KEY)?).ok()?;
    mac.update(&decode_hex(SALT)?);
    mac.update(path.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Some(format!(
        "{}/{signature}{path}",
        settings.url.trim().trim_end_matches('/')
    ))
}
fn decode_hex(input: &str) -> Option<Vec<u8>> {
    if !input.is_ascii() || !input.len().is_multiple_of(2) {
        return None;
    }
    (0..input.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&input[index..index + 2], 16).ok())
        .collect()
}
pub fn person(person: &mut Person, settings: &ImageProxySettings) {
    person.picture_url = person
        .picture_url
        .as_deref()
        .and_then(|url| image_url(url, settings, 128, 128, true));
}
pub fn profile(profile: &mut Profile, settings: &ImageProxySettings) {
    person(&mut profile.person, settings);
    for person_value in profile
        .following
        .iter_mut()
        .chain(profile.followers.iter_mut())
        .chain(profile.followed_by_known.iter_mut())
    {
        person(person_value, settings);
    }
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

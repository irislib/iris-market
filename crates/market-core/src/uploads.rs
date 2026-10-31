//! Explicit public listing uploads. Platforms re-encode photos to strip EXIF/GPS.
use anyhow::{Context, Result, ensure};
use nostr::Keys;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::time::Duration;

pub const MAX_BYTES: usize = 8 * 1024 * 1024;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaUpload {
    pub url: String,
    pub nhash: String,
    pub file_link: String,
    pub name: String,
    pub mime: String,
    pub size: usize,
    pub is_image: bool,
}
pub fn describe(bytes: &[u8], name: &str, mime: &str) -> Result<MediaUpload> {
    ensure!(
        !bytes.is_empty() && bytes.len() <= MAX_BYTES,
        "Choose a file between 1 byte and 8 MiB."
    );
    let (mime, extension, is_image) = match mime {
        "image/jpeg" => {
            ensure!(bytes.starts_with(&[0xff, 0xd8, 0xff]), "Invalid photo.");
            (mime, "jpg", true)
        }
        "image/png" => {
            ensure!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"), "Invalid photo.");
            (mime, "png", true)
        }
        "image/webp" => {
            ensure!(
                bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
                "Invalid photo."
            );
            (mime, "webp", true)
        }
        "application/pdf" => (mime, "pdf", false),
        "text/plain" => (mime, "txt", false),
        "application/zip" => (mime, "zip", false),
        _ => ("application/octet-stream", "bin", false),
    };
    let hash: [u8; 32] = Sha256::digest(bytes).into();
    let hex: String = hash.iter().map(|v| format!("{v:02x}")).collect();
    let nhash = hashtree_core::nhash_encode(&hash)?;
    let name: String = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(160)
        .collect();
    let name = if name.trim().is_empty() {
        format!("file.{extension}")
    } else {
        name.trim().to_owned()
    };
    let mut file_link = url::Url::parse(&format!("htree://{nhash}/"))?;
    file_link
        .path_segments_mut()
        .map_err(|_| anyhow::anyhow!("Invalid file link"))?
        .push(&name);
    Ok(MediaUpload {
        url: format!("https://cdn.iris.to/{hex}.{extension}"),
        nhash,
        file_link: file_link.to_string(),
        name,
        mime: mime.into(),
        size: bytes.len(),
        is_image,
    })
}
async fn upload(keys: Keys, bytes: Vec<u8>, media: &MediaUpload) -> Result<()> {
    let client = hashtree_blossom::BlossomClient::new_empty(keys)
        .with_write_servers(vec!["https://upload.iris.to".into()])
        .with_timeout(Duration::from_secs(15));
    client
        .upload(&bytes)
        .await
        .context("Could not upload the file. Your draft is still here.")?;
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()?;
    let expected = Sha256::digest(&bytes);
    let mut response = http.get(&media.url).send().await?.error_for_status()?;
    ensure!(
        response.content_length().unwrap_or(0) <= MAX_BYTES as u64,
        "Uploaded file is too large"
    );
    let mut digest = Sha256::new();
    let mut length = 0;
    while let Some(chunk) = response.chunk().await? {
        length += chunk.len();
        ensure!(length <= MAX_BYTES, "Uploaded file is too large");
        digest.update(&chunk);
    }
    ensure!(
        length == bytes.len() && digest.finalize() == expected,
        "Could not verify the uploaded file. Retry before publishing."
    );
    Ok(())
}
impl crate::Market {
    /// Called off the UI thread. No listing is published by uploading a selected file.
    pub fn upload_media(&self, bytes: Vec<u8>, name: String, mime: String) -> Result<String> {
        let media = describe(&bytes, &name, &mime)?;
        let keys = {
            let s = self.state.lock().unwrap();
            ensure!(!s.demo, "Leave Preview to upload a file.");
            s.owner_keys
                .clone()
                .context("Sign in with your profile key to upload.")?
        };
        let runtime = self
            .runtime
            .lock()
            .unwrap()
            .as_ref()
            .context("App is closed")?
            .handle()
            .clone();
        runtime.block_on(upload(keys, bytes, &media))?;
        Ok(serde_json::to_string(&media)?)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_leaf_matches_hashtree_and_sanitizes_name() {
        let media = describe(b"hello", "/private/person/hello.txt", "text/plain").unwrap();
        assert_eq!(media.name, "hello.txt");
        assert!(media.url.starts_with("https://cdn.iris.to/2cf24dba"));
        assert_eq!(
            hashtree_core::nhash_decode(&media.nhash).unwrap().hash,
            <[u8; 32]>::from(Sha256::digest(b"hello"))
        );
        assert!(!media.file_link.contains("private"));
        assert!(!media.is_image);
        assert!(describe(b"bad", "a.jpg", "image/jpeg").is_err());
        assert!(describe(&[], "a", "text/plain").is_err());
    }
}

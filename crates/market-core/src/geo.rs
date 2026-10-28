//! Decode public Nostr geohash cells. Textual locations are never geocoded implicitly.
pub fn decode(value: &str) -> Option<[f64; 2]> {
    const ALPHABET: &[u8] = b"0123456789bcdefghjkmnpqrstuvwxyz";
    if value.is_empty() || value.len() > 12 {
        return None;
    }
    let (mut west, mut east, mut south, mut north) = (-180.0, 180.0, -90.0, 90.0);
    let mut longitude = true;
    for character in value.bytes() {
        let bits = ALPHABET
            .iter()
            .position(|c| *c == character.to_ascii_lowercase())?;
        for bit in (0..5).rev() {
            if longitude {
                let mid = (west + east) / 2.0;
                if bits & (1 << bit) != 0 {
                    west = mid;
                } else {
                    east = mid;
                }
            } else {
                let mid = (south + north) / 2.0;
                if bits & (1 << bit) != 0 {
                    south = mid;
                } else {
                    north = mid;
                }
            }
            longitude = !longitude;
        }
    }
    Some([(west + east) / 2.0, (south + north) / 2.0])
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn known_cell_and_invalid_inputs() {
        let p = decode("u60g").unwrap();
        assert_eq!(p, [12.48046875, 56.865234375]);
        assert_eq!(decode("U60G"), Some(p));
        for bad in ["", "a", "Helsinki", "u60gu60gu60gu", "💛"] {
            assert!(decode(bad).is_none());
        }
    }
}

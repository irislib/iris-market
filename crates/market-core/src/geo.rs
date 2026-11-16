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

/// Encodes `[longitude, latitude]` as a geohash of `length` characters (1..=12).
pub fn encode(coordinates: [f64; 2], length: usize) -> Option<String> {
    const ALPHABET: &[u8] = b"0123456789bcdefghjkmnpqrstuvwxyz";
    let [longitude, latitude] = coordinates;
    if !(1..=12).contains(&length)
        || !(-180.0..=180.0).contains(&longitude)
        || !(-90.0..=90.0).contains(&latitude)
    {
        return None;
    }
    let (mut west, mut east, mut south, mut north) = (-180.0, 180.0, -90.0, 90.0);
    let (mut hash, mut bits, mut count, mut even) = (String::new(), 0usize, 0, true);
    while hash.len() < length {
        if even {
            let mid = (west + east) / 2.0;
            bits = bits << 1 | usize::from(longitude >= mid);
            if longitude >= mid {
                west = mid
            } else {
                east = mid
            }
        } else {
            let mid = (south + north) / 2.0;
            bits = bits << 1 | usize::from(latitude >= mid);
            if latitude >= mid {
                south = mid
            } else {
                north = mid
            }
        }
        even = !even;
        count += 1;
        if count == 5 {
            hash.push(ALPHABET[bits] as char);
            (bits, count) = (0, 0);
        }
    }
    Some(hash)
}

#[cfg(test)]
mod encode_tests {
    #[test]
    fn encodes_and_decodes_the_same_cell() {
        // Helsinki city centre.
        let hash = super::encode([24.9384, 60.1699], 6).unwrap();
        assert_eq!(hash, "ud9wr3");
        let [lon, lat] = super::decode(&hash).unwrap();
        assert!((lon - 24.9384).abs() < 0.01 && (lat - 60.1699).abs() < 0.01);
        assert!(super::encode([200.0, 0.0], 4).is_none());
    }
}

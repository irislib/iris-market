//! Names public areas from a bundled public-domain town list; nothing is looked up online.
use std::sync::OnceLock;

struct Town {
    name: &'static str,
    lat: f64,
    lng: f64,
    population: u64,
}

fn towns() -> &'static [Town] {
    static TOWNS: OnceLock<Vec<Town>> = OnceLock::new();
    TOWNS.get_or_init(|| {
        include_str!("../data/towns.tsv")
            .lines()
            .filter(|line| !line.starts_with('#'))
            .filter_map(|line| {
                let mut parts = line.split('\t');
                Some(Town {
                    name: parts.next()?,
                    lat: parts.next()?.parse().ok()?,
                    lng: parts.next()?.parse().ok()?,
                    population: parts.next()?.parse().ok()?,
                })
            })
            .collect()
    })
}

const NEAR_KM: f64 = 30.0;

/// The largest town inside `[west, south, east, north]`, else the nearest one close by.
pub fn area_name([west, south, east, north]: [f64; 4]) -> Option<&'static str> {
    let inside = towns()
        .iter()
        .filter(|t| (west..=east).contains(&t.lng) && (south..=north).contains(&t.lat))
        .max_by_key(|t| t.population);
    if let Some(town) = inside {
        return Some(town.name);
    }
    let (lat, lng) = ((south + north) / 2.0, (west + east) / 2.0);
    let km = |t: &Town| {
        let rad = std::f64::consts::PI / 180.0;
        let x = (lng - t.lng) * rad * ((lat + t.lat) * rad / 2.0).cos();
        let y = (lat - t.lat) * rad;
        x.hypot(y) * 6371.0
    };
    towns()
        .iter()
        .map(|t| (km(t), t))
        .filter(|(d, _)| *d < NEAR_KM)
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, t)| t.name)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn areas_get_the_name_of_their_largest_town() {
        let helsinki = crate::geo::bounds("ud9w").unwrap();
        assert_eq!(area_name(helsinki), Some("Helsinki"));
        let ocean = crate::geo::encode([-30.0, 30.0], 4).unwrap();
        assert_eq!(
            area_name(crate::geo::bounds(&ocean).unwrap()),
            None,
            "open sea has no name"
        );
    }
    #[test]
    fn the_town_list_matches_the_web_place_labels() {
        let web = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../web/src/places/labels.json"
        ))
        .unwrap();
        let labels: serde_json::Value = serde_json::from_str(&web).unwrap();
        let cities = labels["labels"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["kind"] == "city")
            .count();
        assert_eq!(towns().len(), cities, "run scripts/sync-towns");
    }
}

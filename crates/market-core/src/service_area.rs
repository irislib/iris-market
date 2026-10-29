//! Iris Market service-area v1, inside signed kind-30402 listings.
//! `service_area,1,pickup|destination,<GeoJSON>` carries authoritative geometry.
//! `g,<hash>,pickup|destination` is a custom area index, NEVER a point location.
//! Covers can overmatch; callers must use exact geometry containment locally.
use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub type Point = [f64; 2];
pub type Ring = Vec<Point>;
pub type Polygon = Vec<Ring>;
pub type Bounds = [f64; 4];
pub const VERSION: &str = "1";
pub const MAX_VERTICES: usize = 256;
pub const MAX_BYTES: usize = 16 * 1024;
pub const MAX_G_TAGS: usize = 512;
pub const MAX_COVER_LEAVES: usize = 64;
pub const MIN_RADIUS_KM: f64 = 0.1;
pub const MAX_RADIUS_KM: f64 = 2000.0;
const MAX_POLYGONS: usize = 16;
const MAX_RINGS: usize = 32;
const MAX_PRECISION: usize = 8;
const EPSILON: f64 = 1e-10;
const ALPHABET: &[u8] = b"0123456789bcdefghjkmnpqrstuvwxyz";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "coordinates", deny_unknown_fields)]
pub enum Geometry {
    Polygon(Polygon),
    MultiPolygon(Vec<Polygon>),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceAreas {
    pub pickup: Geometry,
    pub destination: Geometry,
}

impl Geometry {
    fn polygons(&self) -> &[Polygon] {
        match self {
            Self::Polygon(polygon) => std::slice::from_ref(polygon),
            Self::MultiPolygon(polygons) => polygons,
        }
    }
}

fn valid_point(p: Point) -> bool {
    p.iter().all(|v| v.is_finite())
        && (-180.0..=180.0).contains(&p[0])
        && (-90.0..=90.0).contains(&p[1])
}
fn cross(a: Point, b: Point, p: Point) -> f64 {
    (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
}
fn on_segment(p: Point, a: Point, b: Point) -> bool {
    cross(a, b, p).abs() <= EPSILON * (b[0] - a[0]).hypot(b[1] - a[1])
        && p[0] >= a[0].min(b[0]) - EPSILON
        && p[0] <= a[0].max(b[0]) + EPSILON
        && p[1] >= a[1].min(b[1]) - EPSILON
        && p[1] <= a[1].max(b[1]) + EPSILON
}
fn intersects(a: Point, b: Point, c: Point, d: Point) -> bool {
    on_segment(a, c, d)
        || on_segment(b, c, d)
        || on_segment(c, a, b)
        || on_segment(d, a, b)
        || ((cross(a, b, c) > 0.0) != (cross(a, b, d) > 0.0)
            && (cross(c, d, a) > 0.0) != (cross(c, d, b) > 0.0))
}
/// -1 outside, 0 boundary, 1 inside; winding does not change containment.
fn in_ring(point: Point, ring: &Ring) -> i8 {
    let mut inside = false;
    for edge in ring.windows(2) {
        let (a, b) = (edge[0], edge[1]);
        if on_segment(point, a, b) {
            return 0;
        }
        if (a[1] > point[1]) != (b[1] > point[1])
            && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]
        {
            inside = !inside;
        }
    }
    if inside { 1 } else { -1 }
}
fn in_polygon(point: Point, polygon: &Polygon) -> bool {
    in_ring(point, &polygon[0]) >= 0 && polygon[1..].iter().all(|hole| in_ring(point, hole) == -1)
}
fn rings_intersect(a: &Ring, b: &Ring) -> bool {
    a.windows(2)
        .any(|x| b.windows(2).any(|y| intersects(x[0], x[1], y[0], y[1])))
}
fn ring_bounds(ring: &Ring) -> Bounds {
    ring.iter()
        .fold([180.0, 90.0, -180.0, -90.0], |mut bounds, p| {
            bounds[0] = bounds[0].min(p[0]);
            bounds[1] = bounds[1].min(p[1]);
            bounds[2] = bounds[2].max(p[0]);
            bounds[3] = bounds[3].max(p[1]);
            bounds
        })
}
fn bounds_of(area: &Geometry) -> Bounds {
    area.polygons()
        .iter()
        .map(|p| ring_bounds(&p[0]))
        .fold([180.0, 90.0, -180.0, -90.0], |a, b| {
            [
                a[0].min(b[0]),
                a[1].min(b[1]),
                a[2].max(b[2]),
                a[3].max(b[3]),
            ]
        })
}

/// Strict bounded GeoJSON validation. Date-line crossings are explicit v1 exclusions.
pub fn validate(area: &Geometry) -> Result<()> {
    let polygons = area.polygons();
    ensure!(
        !polygons.is_empty() && polygons.len() <= MAX_POLYGONS,
        "Too many service-area polygons"
    );
    let (mut vertices, mut rings) = (0usize, 0usize);
    for (p_index, polygon) in polygons.iter().enumerate() {
        rings = rings.saturating_add(polygon.len());
        ensure!(
            !polygon.is_empty() && rings <= MAX_RINGS,
            "Too many service-area rings"
        );
        for (r_index, ring) in polygon.iter().enumerate() {
            vertices = vertices.saturating_add(ring.len());
            ensure!(
                ring.len() >= 4 && vertices <= MAX_VERTICES,
                "Service-area outlines are too detailed"
            );
            ensure!(
                ring.iter().all(|p| valid_point(*p)),
                "Service-area coordinates must be finite WGS84 longitude and latitude"
            );
            ensure!(ring.first() == ring.last(), "Close every service-area ring");
            for i in 0..ring.len() - 1 {
                ensure!(
                    ring[i] != ring[i + 1],
                    "Service-area rings contain duplicate points"
                );
                ensure!(
                    (ring[i][0] - ring[i + 1][0]).abs() <= 180.0,
                    "Service areas crossing the date line are not supported yet"
                );
                for j in i + 1..ring.len() - 1 {
                    if j == i + 1 || (i == 0 && j == ring.len() - 2) {
                        continue;
                    }
                    ensure!(
                        !intersects(ring[i], ring[i + 1], ring[j], ring[j + 1]),
                        "Service-area rings must not cross themselves"
                    );
                }
            }
            let signed_area: f64 = ring
                .windows(2)
                .map(|e| e[0][0] * e[1][1] - e[1][0] * e[0][1])
                .sum();
            ensure!(
                signed_area.abs() >= 1e-12,
                "Service areas need a nonzero area"
            );
            if r_index > 0 {
                ensure!(
                    in_ring(ring[0], &polygon[0]) == 1 && !rings_intersect(ring, &polygon[0]),
                    "Service-area holes must stay inside the outline"
                );
                for hole in &polygon[1..r_index] {
                    ensure!(
                        !rings_intersect(ring, hole)
                            && in_ring(ring[0], hole) < 0
                            && in_ring(hole[0], ring) < 0,
                        "Service-area holes must not overlap"
                    );
                }
            }
        }
        for previous in &polygons[..p_index] {
            ensure!(
                !polygon
                    .iter()
                    .any(|a| previous.iter().any(|b| rings_intersect(a, b)))
                    && !in_polygon(polygon[0][0], previous)
                    && !in_polygon(previous[0][0], polygon),
                "Service-area polygons must not overlap or touch"
            );
        }
    }
    let bounds = bounds_of(area);
    ensure!(
        bounds[2] - bounds[0] <= 180.0,
        "Service areas crossing the date line are not supported yet"
    );
    ensure!(
        serde_json::to_vec(area)?.len() <= MAX_BYTES,
        "Service area is too large"
    );
    Ok(())
}

/// Malformed, duplicate, unsupported, or incomplete pairs are unusable.
pub fn parse_tags(tags: &[Vec<String>]) -> Option<ServiceAreas> {
    if tags.len() > 2048 {
        return None;
    }
    let rows: Vec<_> = tags
        .iter()
        .filter(|tag| tag.first().is_some_and(|v| v == "service_area"))
        .collect();
    if rows.len() != 2 {
        return None;
    }
    let (mut pickup, mut destination) = (None, None);
    for row in rows {
        if row.len() != 4 || row[1] != VERSION || row[3].len() > MAX_BYTES {
            return None;
        }
        let area: Geometry = serde_json::from_str(&row[3]).ok()?;
        validate(&area).ok()?;
        let target = match row[2].as_str() {
            "pickup" => &mut pickup,
            "destination" => &mut destination,
            _ => return None,
        };
        if target.is_some() {
            return None;
        }
        *target = Some(area);
    }
    Some(ServiceAreas {
        pickup: pickup?,
        destination: destination?,
    })
}

/// Outer boundaries count. Hole boundaries and malformed geometry do not.
pub fn contains(area: &Geometry, point: Point) -> bool {
    valid_point(point)
        && validate(area).is_ok()
        && area.polygons().iter().any(|p| in_polygon(point, p))
}
pub fn bounds(area: &Geometry) -> Result<Bounds> {
    validate(area)?;
    Ok(bounds_of(area))
}
/// Camera centre only; may be outside a concave area or inside a hole.
pub fn center(area: &Geometry) -> Result<Point> {
    let [west, south, east, north] = bounds(area)?;
    Ok([(west + east) / 2.0, (south + north) / 2.0])
}
/// 64-edge geodesic circle in kilometres, rounded to six decimal coordinate places.
pub fn circle(center: Point, radius_km: f64) -> Result<Geometry> {
    ensure!(
        valid_point(center)
            && radius_km.is_finite()
            && (MIN_RADIUS_KM..=MAX_RADIUS_KM).contains(&radius_km),
        "Choose a radius from 0.1 to 2000 km"
    );
    let (lat, lon, distance) = (
        center[1].to_radians(),
        center[0].to_radians(),
        radius_km / 6371.0088,
    );
    let mut ring = Vec::with_capacity(65);
    let rounded = |v: f64| (v * 1_000_000.0).round() / 1_000_000.0;
    for i in 0..64 {
        let bearing = f64::from(i) * std::f64::consts::PI / 32.0;
        let phi = (lat.sin() * distance.cos() + lat.cos() * distance.sin() * bearing.cos()).asin();
        let lambda = lon
            + (bearing.sin() * distance.sin() * lat.cos())
                .atan2(distance.cos() - lat.sin() * phi.sin());
        ring.push([
            rounded((lambda.to_degrees() + 180.0).rem_euclid(360.0) - 180.0),
            rounded(phi.to_degrees()),
        ]);
    }
    ring.push(ring[0]);
    let area = Geometry::Polygon(vec![ring]);
    validate(&area)?;
    Ok(area)
}

fn grid_hash(x: u32, y: u32, precision: usize) -> String {
    let (mut lon_bit, mut lat_bit) = (
        ((precision * 5).div_ceil(2) - 1) as i32,
        (precision * 5 / 2 - 1) as i32,
    );
    let (mut character, mut value) = (0usize, String::with_capacity(precision));
    for bit in 0..precision * 5 {
        let next = if bit % 2 == 0 {
            let next = (x >> lon_bit) & 1;
            lon_bit -= 1;
            next
        } else {
            let next = (y >> lat_bit) & 1;
            lat_bit -= 1;
            next
        };
        character = character * 2 + next as usize;
        if bit % 5 == 4 {
            value.push(char::from(ALPHABET[character]));
            character = 0;
        }
    }
    value
}
fn cover_at(area: &Geometry, precision: usize) -> Option<BTreeSet<String>> {
    let (columns, rows) = (
        1u32 << (precision * 5).div_ceil(2),
        1u32 << (precision * 5 / 2),
    );
    let column =
        |lon: f64| (((lon + 180.0) / 360.0 * f64::from(columns)).floor() as u32).min(columns - 1);
    let row = |lat: f64| (((lat + 90.0) / 180.0 * f64::from(rows)).floor() as u32).min(rows - 1);
    let mut cells = BTreeSet::new();
    for polygon in area.polygons() {
        let [west, south, east, north] = ring_bounds(&polygon[0]);
        let (x0, x1, y0, y1) = (column(west), column(east), row(south), row(north));
        if u64::from(x1 - x0 + 1) * u64::from(y1 - y0 + 1) > MAX_COVER_LEAVES as u64 {
            return None;
        }
        for x in x0..=x1 {
            for y in y0..=y1 {
                cells.insert(grid_hash(x, y, precision));
                if cells.len() > MAX_COVER_LEAVES {
                    return None;
                }
            }
        }
    }
    Some(cells)
}
fn indexed_cells(area: &Geometry) -> Result<BTreeSet<String>> {
    for precision in (1..=MAX_PRECISION).rev() {
        let Some(leaves) = cover_at(area, precision) else {
            continue;
        };
        let mut cells = BTreeSet::new();
        for leaf in leaves {
            for length in 1..=leaf.len() {
                cells.insert(leaf[..length].to_owned());
            }
        }
        if cells.len() <= MAX_G_TAGS / 2 {
            return Ok(cells);
        }
    }
    bail!("Service area cannot be indexed")
}
pub fn to_tags(areas: &ServiceAreas) -> Result<Vec<Vec<String>>> {
    validate(&areas.pickup)?;
    validate(&areas.destination)?;
    let mut tags = Vec::new();
    for (role, area) in [
        ("pickup", &areas.pickup),
        ("destination", &areas.destination),
    ] {
        tags.push(vec![
            "service_area".into(),
            VERSION.into(),
            role.into(),
            serde_json::to_string(area)?,
        ]);
        for hash in indexed_cells(area)? {
            tags.push(vec!["g".into(), hash, role.into()]);
        }
    }
    Ok(tags)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    fn fixtures() -> Value {
        serde_json::from_str(include_str!("../fixtures/service-areas-v1.json")).unwrap()
    }
    #[test]
    fn shared_web_fixtures_roundtrip_containment_and_exact_indexes() {
        for case in fixtures()["cases"].as_array().unwrap() {
            let areas: ServiceAreas = serde_json::from_value(case["areas"].clone()).unwrap();
            let tags = to_tags(&areas).unwrap();
            assert_eq!(parse_tags(&tags), Some(areas.clone()), "{}", case["id"]);
            assert!(tags.iter().filter(|t| t[0] == "g").count() <= MAX_G_TAGS);
            for (role, area) in [
                ("pickup", &areas.pickup),
                ("destination", &areas.destination),
            ] {
                let hashes: Vec<_> = tags
                    .iter()
                    .filter(|t| t[0] == "g" && t[2] == role)
                    .map(|t| t[1].clone())
                    .collect();
                assert_eq!(
                    hashes,
                    serde_json::from_value::<Vec<String>>(case["indexes"][role].clone()).unwrap(),
                    "{} {role}",
                    case["id"]
                );
                let precision = hashes.iter().map(String::len).max().unwrap();
                assert!(hashes.iter().filter(|h| h.len() == precision).count() <= MAX_COVER_LEAVES);
                for probe in case["probes"].as_array().unwrap() {
                    let point: Point = serde_json::from_value(probe["point"].clone()).unwrap();
                    assert_eq!(
                        contains(area, point),
                        probe[role].as_bool().unwrap(),
                        "{} {role} {point:?}",
                        case["id"]
                    );
                }
            }
            // Indexes cannot be mistaken for the legacy two-field point tags.
            assert!(
                tags.iter()
                    .filter(|t| t[0] == "g")
                    .all(|t| t.len() == 3 && ["pickup", "destination"].contains(&t[2].as_str()))
            );
        }
    }
    #[test]
    fn malformed_geometry_and_incomplete_signed_tags_fail_closed() {
        for invalid in fixtures()["invalidGeometries"].as_array().unwrap() {
            let rejected = match serde_json::from_value::<Geometry>(invalid["geometry"].clone()) {
                Ok(area) => validate(&area).is_err(),
                Err(_) => true,
            };
            assert!(rejected, "{}", invalid["id"]);
        }
        let area = circle([25.0, 60.0], 10.0).unwrap();
        let tags = to_tags(&ServiceAreas {
            pickup: area.clone(),
            destination: area,
        })
        .unwrap();
        let rows: Vec<_> = tags
            .iter()
            .filter(|t| t[0] == "service_area")
            .cloned()
            .collect();
        assert!(parse_tags(&rows[..1]).is_none());
        assert!(parse_tags(&[rows[0].clone(), rows[0].clone()]).is_none());
        let mut future = rows.clone();
        future[1][1] = "2".into();
        assert!(parse_tags(&future).is_none());
        let mut oversized = rows;
        oversized[1][3] = " ".repeat(MAX_BYTES + 1);
        assert!(parse_tags(&oversized).is_none());
    }
    #[test]
    fn northern_circles_preserve_radius_and_reject_dateline_crossings() {
        for case in fixtures()["circles"].as_array().unwrap() {
            let point: Point = serde_json::from_value(case["center"].clone()).unwrap();
            let radius = case["radiusKm"].as_f64().unwrap();
            let area = circle(point, radius).unwrap();
            let expected: Geometry = serde_json::from_value(case["geometry"].clone()).unwrap();
            assert!(contains(&area, point));
            for (a, b) in area.polygons()[0][0].iter().zip(&expected.polygons()[0][0]) {
                assert!((a[0] - b[0]).abs() <= 0.000001 && (a[1] - b[1]).abs() <= 0.000001);
            }
        }
        for radius in [0.0, -1.0, 2001.0, f64::NAN, f64::INFINITY] {
            assert!(circle([25.0, 60.0], radius).is_err());
        }
        assert!(circle([179.9, 20.0], 100.0).is_err());
    }
    #[test]
    fn vertex_caps_nonfinite_points_and_camera_center_are_explicit() {
        let mut ring = vec![[0.0, 0.0]; MAX_VERTICES + 1];
        ring[1] = [1.0, 0.0];
        ring[2] = [1.0, 1.0];
        assert!(validate(&Geometry::Polygon(vec![ring])).is_err());
        let area: Geometry = serde_json::from_value(json!({"type":"Polygon","coordinates":[[[0,0],[10,0],[10,10],[0,10],[0,0]],[[3,3],[7,3],[7,7],[3,7],[3,3]]]})).unwrap();
        assert_eq!(center(&area).unwrap(), [5.0, 5.0]);
        assert!(!contains(&area, [5.0, 5.0]));
        assert!(!contains(&area, [f64::NAN, 5.0]));
    }
}

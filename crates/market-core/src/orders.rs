//! Private orders carried inside authenticated Iris Chat kind-14 messages.
//! The caller commits this book and the ratchet checkpoint in one encrypted
//! transaction. A relay acknowledgement is delivery to a relay, never payment.

use std::collections::{BTreeMap, BTreeSet};

use nostr::{JsonUtil, PublicKey, UnsignedEvent};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

pub const ORDER_TAG: &str = "iris-market-order";
pub const LOCATION_TTL: u64 = 120;
const MAX_ORDERS: usize = 256;
const MAX_JOBS: usize = 512;
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OrderStatus {
    Requested,
    Accepted,
    InTransit,
    Delivered,
    Cancelled,
}
impl OrderStatus {
    fn terminal(&self) -> bool {
        matches!(self, Self::Delivered | Self::Cancelled)
    }
    fn rank(&self) -> u8 {
        match self {
            Self::Requested => 0,
            Self::Accepted => 1,
            Self::InTransit => 2,
            Self::Delivered => 3,
            Self::Cancelled => 4,
        }
    }
    fn label(&self) -> &'static str {
        match self {
            Self::Requested => "requested",
            Self::Accepted => "accepted",
            Self::InTransit => "in-transit",
            Self::Delivered => "delivered",
            Self::Cancelled => "cancelled",
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Default)]
#[serde(rename_all = "lowercase")]
pub enum StopStatus {
    #[default]
    Pending,
    Arrived,
    Completed,
}
impl StopStatus {
    fn label(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Arrived => "arrived",
            Self::Completed => "completed",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShipmentStop {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub status: StopStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinates: Option<[f64; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub courier_pubkey: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShipmentLocation {
    pub coordinates: [f64; 2],
    pub at: u64,
    pub courier_pubkey: String,
    pub stop_id: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Shipment {
    pub stops: Vec<ShipmentStop>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracking_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eta: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<ShipmentLocation>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrderItem {
    pub id: String,
    pub title: String,
    pub price: String,
    pub currency: String,
    pub quantity: u16,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PaymentStatus {
    Requested,
    Received,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrderPayment {
    pub mint: String,
    pub amount: String,
    pub unit: String,
    pub status: PaymentStatus,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DeliveryPlace {
    pub label: String,
    pub address: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinates: Option<[f64; 2]>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Collection {
    pub merchant: String,
    pub reference: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DeliveryRequest {
    pub pickup: DeliveryPlace,
    pub destination: DeliveryPlace,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection: Option<Collection>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PickupAuthorization {
    pub courier_pubkey: String,
    pub reference: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payment: Option<OrderPayment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_request: Option<DeliveryRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pickup_authorization: Option<PickupAuthorization>,
    pub id: String,
    pub buyer: String,
    pub seller: String,
    pub items: Vec<OrderItem>,
    #[serde(default)]
    pub note: String,
    pub status: OrderStatus,
    pub created_at: u64,
    pub updated_at: u64,
    pub shipment: Shipment,
    #[serde(default)]
    pub route_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderView {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_order_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_order_id: Option<String>,
    #[serde(
        default,
        rename = "display_price",
        skip_serializing_if = "Option::is_none"
    )]
    pub display_price: Option<crate::rates::DisplayPrice>,
    #[serde(flatten)]
    pub order: Order,
    pub archived: bool,
    pub role: Option<String>,
    pub sync: String,
    pub location_fresh: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub v: u8,
    pub id: String,
    pub op_id: String,
    pub seq: u64,
    pub at: u64,
    pub action: String,
    pub payload: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<Order>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Record {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_order_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    delivery_order_id: Option<String>,
    order: Order,
    clocks: BTreeMap<String, u64>,
    archived: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Job {
    pub id: String,
    pub order_id: String,
    pub recipient: String,
    pub rumor: UnsignedEvent,
    pub action: String,
    pub handed: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Pending {
    event: Envelope,
    sender: String,
    device: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct OrderBook {
    #[serde(default)]
    ephemeral: Vec<Ephemeral>,
    #[serde(skip)]
    developer_mint: Option<String>,
    records: BTreeMap<String, Record>,
    pub(crate) jobs: Vec<Job>,
    #[serde(default)]
    blocked: BTreeSet<String>,
    #[serde(default)]
    pending: Vec<Pending>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Ephemeral {
    id: String,
    order_id: String,
    op_id: String,
    expires_at: u64,
}

fn local_mint(value: &str) -> Result<String> {
    let url = url::Url::parse(value).map_err(|_| "Invalid local test mint")?;
    require(
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port().is_some()
            && url.path() == "/"
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "Invalid local test mint",
    )?;
    Ok(url.as_str().trim_end_matches('/').to_owned())
}
fn payment(mut value: OrderPayment, developer_mint: Option<&str>) -> Result<OrderPayment> {
    require(
        value.unit == "sat"
            && !value.amount.is_empty()
            && value.amount.len() <= 13
            && value.amount.bytes().all(|b| b.is_ascii_digit()),
        "Invalid payment",
    )?;
    let amount = value
        .amount
        .parse::<u64>()
        .map_err(|_| "Invalid payment amount")?;
    require(
        (1..=1_000_000_000_000).contains(&amount),
        "Invalid payment amount",
    )?;
    let url = url::Url::parse(&value.mint).map_err(|_| "Invalid payment mint")?;
    let mint = url
        .as_str()
        .strip_suffix('/')
        .unwrap_or(url.as_str())
        .to_owned();
    let permitted_local = developer_mint
        .is_some_and(|expected| local_mint(expected).is_ok_and(|expected| expected == mint));
    require(
        text(&value.mint, 2048, false)
            && (url.scheme() == "https" || permitted_local)
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "Use a secure payment mint",
    )?;
    value.mint = mint;
    value.amount = amount.to_string();
    Ok(value)
}
fn delivery_place(value: &DeliveryPlace) -> Result<()> {
    require(
        text(&value.label, 120, true)
            && text(&value.address, 500, false)
            && value.coordinates.is_none_or(coordinates),
        "Invalid delivery place",
    )
}
fn delivery_request(value: &DeliveryRequest) -> Result<()> {
    delivery_place(&value.pickup)?;
    delivery_place(&value.destination)?;
    if let Some(collection) = &value.collection {
        require(
            hex(&collection.merchant) && text(&collection.reference, 80, false),
            "Invalid collection reference",
        )?;
    }
    Ok(())
}
fn pickup_authorization(value: &PickupAuthorization) -> Result<()> {
    require(
        hex(&value.courier_pubkey) && text(&value.reference, 80, false),
        "Invalid pickup authorization",
    )
}

fn require(condition: bool, message: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}
fn text(value: &str, max: usize, empty: bool) -> bool {
    value.chars().count() <= max && (empty || !value.trim().is_empty())
}
fn hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
fn coordinates(value: [f64; 2]) -> bool {
    value[0].is_finite() && value[1].is_finite() && value[0].abs() <= 180. && value[1].abs() <= 90.
}
fn parse<T: for<'a> Deserialize<'a>>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| "Invalid order update".into())
}
fn wire_shipment(mut value: Shipment) -> Result<Shipment> {
    require(value.stops.len() <= 12, "Use up to 12 delivery stops")?;
    let mut ids = BTreeSet::new();
    for stop in &value.stops {
        require(
            text(&stop.id, 80, false)
                && ids.insert(stop.id.clone())
                && text(&stop.label, 120, true)
                && text(&stop.address, 500, true),
            "Invalid delivery stop",
        )?;
        require(
            stop.coordinates.is_none_or(coordinates)
                && stop.courier_pubkey.as_deref().is_none_or(hex),
            "Invalid delivery location or courier",
        )?;
    }
    if let Some(link) = &mut value.tracking_url {
        let url = url::Url::parse(link).map_err(|_| "Use a secure tracking link")?;
        require(
            link.len() <= 2048
                && url.scheme() == "https"
                && url.username().is_empty()
                && url.password().is_none(),
            "Use a secure tracking link",
        )?;
        *link = url.to_string();
    }
    require(
        value.eta.is_none_or(|eta| eta <= 9_007_199_254_740_991),
        "Invalid delivery time",
    )?;
    value.location = None; // Snapshots and routes never carry position history.
    Ok(value)
}
fn snapshot_with_mint(mut value: Order, developer_mint: Option<&str>) -> Result<Order> {
    value.payment = value
        .payment
        .map(|value| payment(value, developer_mint))
        .transpose()?;
    if let Some(value) = &value.delivery_request {
        delivery_request(value)?;
    }
    if let Some(value) = &value.pickup_authorization {
        pickup_authorization(value)?;
    }
    require(
        hex(&value.buyer)
            && hex(&value.seller)
            && value.buyer != value.seller
            && value
                .id
                .strip_prefix(&format!("{}:", value.buyer))
                .is_some_and(uuid),
        "Invalid order identity",
    )?;
    require(value.items.len() == 1, "One listing per order is supported")?;
    for item in &mut value.items {
        item.currency.make_ascii_uppercase();
        let valid_price = item.price.is_empty()
            || (item.price.len() <= 24
                && item
                    .price
                    .bytes()
                    .all(|b| b.is_ascii_digit() || b"+.eE-".contains(&b))
                && !item.price.starts_with('-')
                && item
                    .price
                    .parse::<f64>()
                    .is_ok_and(|p| p.is_finite() && p >= 0.));
        require(
            (1..=999).contains(&item.quantity)
                && valid_price
                && (3..=12).contains(&item.currency.len())
                && item.currency.bytes().all(|c| c.is_ascii_uppercase())
                && item.id.starts_with(&format!("{}:", value.seller))
                && text(&item.id, 240, false)
                && text(&item.title, 160, false),
            "Invalid order item",
        )?;
    }
    require(
        text(&value.note, 2000, true)
            && value.updated_at >= value.created_at
            && value.updated_at <= 9_007_199_254_740_991
            && text(&value.route_id, 36, true),
        "Invalid order state",
    )?;
    value.shipment = wire_shipment(value.shipment)?;
    Ok(value)
}
fn immutable(a: &Order, b: &Order) -> bool {
    a.id == b.id
        && a.buyer == b.buyer
        && a.seller == b.seller
        && a.items == b.items
        && a.note == b.note
        && a.created_at == b.created_at
        && a.delivery_request == b.delivery_request
}
fn role(order: &Order, owner: &str) -> Option<&'static str> {
    if order.buyer == owner {
        Some("buyer")
    } else if order.seller == owner {
        Some("seller")
    } else if order
        .shipment
        .stops
        .iter()
        .any(|stop| stop.courier_pubkey.as_deref() == Some(owner))
    {
        Some("courier")
    } else {
        None
    }
}
fn recipients(order: &Order) -> BTreeSet<String> {
    [order.buyer.clone(), order.seller.clone()]
        .into_iter()
        .chain(
            order
                .shipment
                .stops
                .iter()
                .filter_map(|stop| stop.courier_pubkey.clone()),
        )
        .collect()
}
fn apply_with_mint(
    previous: Option<&Record>,
    event: &Envelope,
    sender: &str,
    device: &str,
    owner: &str,
    now: u64,
    developer_mint: Option<&str>,
) -> Result<(Record, bool)> {
    let snapshot = |value| snapshot_with_mint(value, developer_mint);
    require(
        hex(sender)
            && hex(device)
            && hex(owner)
            && event.v == 1
            && uuid(&event.op_id)
            && (1..=1_000_000_000).contains(&event.seq)
            && event.at <= now.saturating_add(300),
        "Invalid order update",
    )?;
    let mut record = if let Some(record) = previous {
        record.clone()
    } else {
        let order = if event.action == "request" {
            let order = snapshot(parse(event.payload.clone())?)?;
            require(
                order.id == event.id
                    && order.buyer == sender
                    && (owner == order.buyer || owner == order.seller)
                    && order.status == OrderStatus::Requested
                    && order.shipment.stops.is_empty()
                    && order.shipment.tracking_url.is_none()
                    && order.route_id.is_empty()
                    && order.payment.is_none()
                    && order.pickup_authorization.is_none(),
                "Invalid order request",
            )?;
            order
        } else if event.action == "route" {
            let order = snapshot(event.snapshot.clone().ok_or("Order not found")?)?;
            require(
                order.id == event.id
                    && order.seller == sender
                    && owner != order.buyer
                    && owner != order.seller
                    && role(&order, owner) == Some("courier")
                    && !order.status.terminal()
                    && order.status != OrderStatus::Requested,
                "Only the seller can introduce a courier",
            )?;
            order
        } else {
            return Err("Order not found".into());
        };
        Record {
            source_order_id: None,
            delivery_order_id: None,
            order,
            clocks: BTreeMap::new(),
            archived: false,
        }
    };
    let order = &mut record.order;
    require(
        order.created_at <= now.saturating_add(300)
            && order.updated_at <= now.saturating_add(300)
            && order.id == event.id
            && role(order, owner).is_some(),
        "Invalid order timestamp or recipient",
    )?;
    let clock = format!("{sender}:{device}");
    if event.seq <= *record.clocks.get(&clock).unwrap_or(&0) {
        return Ok((record, false));
    }
    let sender_role = role(order, sender).ok_or("This person cannot update the order")?;
    if previous.is_some()
        && matches!(sender_role, "seller" | "buyer")
        && let Some(current) = event.snapshot.clone()
    {
        let current = snapshot(current)?;
        require(
            immutable(order, &current),
            "Delivery update changed the order",
        )?;
        if sender_role == "seller" {
            if current.payment.is_some()
                && !order
                    .payment
                    .as_ref()
                    .is_some_and(|payment| payment.status == PaymentStatus::Received)
            {
                order.payment = current.payment;
            }
            if !order.status.terminal() {
                if !current.route_id.is_empty() {
                    order.shipment = current.shipment;
                    order.route_id = current.route_id;
                }
                if !current.status.terminal() && current.status.rank() > order.status.rank() {
                    order.status = current.status;
                }
            }
        } else if matches!(order.status, OrderStatus::Accepted | OrderStatus::InTransit) {
            order.pickup_authorization = current.pickup_authorization;
        }
    }
    match event.action.as_str() {
        "request" => require(
            sender_role == "buyer"
                && previous.is_none()
                && immutable(order, &snapshot(parse(event.payload.clone())?)?),
            "Order request cannot replace an order",
        )?,
        "payment" => {
            require(
                sender_role == "seller",
                "Only the seller can update payment",
            )?;
            let next = payment(parse(event.payload.clone())?, developer_mint)?;
            require(
                !order.payment.as_ref().is_some_and(|previous| {
                    previous.status == PaymentStatus::Received && previous != &next
                }),
                "Received payment cannot change",
            )?;
            order.payment = Some(next);
        }
        "pickup" => {
            require(
                sender_role == "buyer"
                    && matches!(order.status, OrderStatus::Accepted | OrderStatus::InTransit),
                "Only the buyer can authorize pickup on an accepted order",
            )?;
            order.pickup_authorization = if event.payload.is_null() {
                None
            } else {
                let value: PickupAuthorization = parse(event.payload.clone())?;
                pickup_authorization(&value)?;
                Some(value)
            };
        }
        "status" => {
            let next: OrderStatus =
                parse(event.payload.get("status").cloned().unwrap_or(Value::Null))?;
            if order.status.terminal() {
                if next == order.status {
                    return Ok((record, false));
                }
                return Err("This order is finished".into());
            }
            let allowed = sender_role != "courier"
                && match next {
                    OrderStatus::Cancelled => true,
                    OrderStatus::Accepted => {
                        sender_role == "seller"
                            && matches!(
                                order.status,
                                OrderStatus::Requested | OrderStatus::Accepted
                            )
                    }
                    OrderStatus::InTransit => {
                        sender_role == "seller"
                            && matches!(
                                order.status,
                                OrderStatus::Accepted | OrderStatus::InTransit
                            )
                    }
                    OrderStatus::Delivered => {
                        matches!(order.status, OrderStatus::Accepted | OrderStatus::InTransit)
                            || (sender_role == "seller"
                                && event
                                    .snapshot
                                    .as_ref()
                                    .is_some_and(|s| s.status == OrderStatus::Delivered))
                    }
                    OrderStatus::Requested => false,
                };
            require(allowed, "Invalid order status change")?;
            order.status = next;
            if order.status.terminal() {
                order.shipment.location = None;
            }
        }
        "route" => {
            require(
                sender_role == "seller"
                    && !order.status.terminal()
                    && order.status != OrderStatus::Requested,
                "Only an accepted order can have delivery details",
            )?;
            require(
                immutable(
                    order,
                    &snapshot(event.snapshot.clone().ok_or("Missing order snapshot")?)?,
                ),
                "Delivery update changed the order",
            )?;
            order.shipment = wire_shipment(parse(event.payload.clone())?)?;
            order.route_id = event.op_id.clone();
        }
        "stop" | "location" => {
            require(
                matches!(sender_role, "seller" | "courier")
                    && (!order.status.terminal()
                        || (event.action == "location" && event.payload.is_null())),
                "Only the seller or assigned courier can update delivery",
            )?;
            if event.action == "location" && event.payload.is_null() {
                require(
                    sender_role != "courier"
                        || (event.route_id.as_deref() == Some(&order.route_id)
                            && order
                                .shipment
                                .location
                                .as_ref()
                                .is_none_or(|p| p.courier_pubkey == sender)),
                    "You can only stop your own location sharing",
                )?;
                order.shipment.location = None;
            } else {
                let stop_id = event
                    .payload
                    .get("stopId")
                    .and_then(Value::as_str)
                    .ok_or("Missing delivery stop")?;
                let stop = order
                    .shipment
                    .stops
                    .iter_mut()
                    .find(|stop| stop.id == stop_id)
                    .ok_or("Delivery stop not found")?;
                require(
                    sender_role != "courier"
                        || (stop.courier_pubkey.as_deref() == Some(sender)
                            && event.route_id.as_deref() == Some(&order.route_id)),
                    "This courier is not assigned to this delivery stop",
                )?;
                if event.action == "stop" {
                    let next: StopStatus =
                        parse(event.payload.get("status").cloned().unwrap_or(Value::Null))?;
                    require(next >= stop.status, "Invalid delivery stop change")?;
                    stop.status = next;
                    if stop.status == StopStatus::Completed
                        && order
                            .shipment
                            .location
                            .as_ref()
                            .is_some_and(|p| p.stop_id == stop_id)
                    {
                        order.shipment.location = None;
                    }
                } else {
                    if event.at > now || now - event.at >= LOCATION_TTL {
                        return Ok((record, false));
                    }
                    require(
                        stop.status != StopStatus::Completed,
                        "This delivery stop is complete",
                    )?;
                    let point: [f64; 2] = parse(
                        event
                            .payload
                            .get("coordinates")
                            .cloned()
                            .unwrap_or(Value::Null),
                    )?;
                    require(coordinates(point), "Invalid map location")?;
                    order.shipment.location = Some(ShipmentLocation {
                        coordinates: point,
                        at: event.at,
                        courier_pubkey: sender.into(),
                        stop_id: stop_id.into(),
                    });
                }
            }
        }
        _ => return Err("Unknown order action".into()),
    }
    require(
        role(order, owner).is_some(),
        "This order is no longer assigned to you",
    )?;
    record.clocks.insert(clock, event.seq);
    order.updated_at = order.updated_at.max(event.at);
    Ok((record, true))
}

#[cfg(test)]
fn apply(
    previous: Option<&Record>,
    event: &Envelope,
    sender: &str,
    device: &str,
    owner: &str,
    now: u64,
) -> Result<(Record, bool)> {
    apply_with_mint(previous, event, sender, device, owner, now, None)
}

pub fn is_order_message(rumor: &UnsignedEvent) -> bool {
    rumor
        .tags
        .iter()
        .any(|t| t.as_slice().first().is_some_and(|s| s == ORDER_TAG))
}
pub fn decode(rumor: &UnsignedEvent) -> Option<Envelope> {
    if rumor.kind.as_u16() != 14 {
        return None;
    }
    let mut tags = rumor
        .tags
        .iter()
        .filter(|t| t.as_slice().first().is_some_and(|s| s == ORDER_TAG));
    let tag = tags.next()?.as_slice();
    if tags.next().is_some() || tag.len() != 3 || tag[1] != "1" || tag[2].len() > 24_000 {
        return None;
    }
    serde_json::from_str(&tag[2]).ok()
}
fn message_text(event: &Envelope, order: &Order) -> String {
    let title = &order.items[0].title;
    match event.action.as_str() {
        "request" => format!(
            "Order requested: {} × {}{}",
            order.items[0].quantity,
            title,
            if order.note.is_empty() {
                String::new()
            } else {
                format!("\n{}", order.note)
            }
        ),
        "payment" => {
            if event.payload["status"] == "received" {
                "Payment received (seller confirmation).".into()
            } else {
                "Payment requested.".into()
            }
        }
        "pickup" => format!("Pickup authorization updated for {title}."),
        "route" => format!("Delivery details updated for {title}."),
        "stop" => format!(
            "Delivery stop {} for {title}.",
            parse::<StopStatus>(event.payload["status"].clone())
                .map(|v| v.label())
                .unwrap_or("updated")
        ),
        "location" => {
            if event.payload.is_null() {
                "Location sharing stopped.".into()
            } else {
                "Delivery location shared temporarily.".into()
            }
        }
        _ => format!(
            "Order {}: {title}.",
            parse::<OrderStatus>(event.payload["status"].clone())
                .map(|v| v.label())
                .unwrap_or("updated")
        ),
    }
}
impl OrderBook {
    pub(crate) fn get(&self, id: &str) -> Option<&Order> {
        self.records.get(id).map(|record| &record.order)
    }
    pub(crate) fn buyer_payment_request(
        &self,
        id: &str,
        owner: &str,
    ) -> Result<(String, OrderPayment)> {
        let order = self.get(id).ok_or("Order not found")?;
        require(
            order.buyer == owner,
            "Only the buyer can send this order payment",
        )?;
        require(!order.status.terminal(), "This order is finished")?;
        let request = order.payment.clone().ok_or("No payment requested")?;
        require(
            request.status == PaymentStatus::Requested,
            "Payment is already received",
        )?;
        Ok((
            order.seller.clone(),
            payment(request, self.developer_mint.as_deref())?,
        ))
    }
    pub(crate) fn context_participant(&self, id: &str, owner: &str, peer: &str) -> bool {
        self.records.get(id).is_some_and(|record| {
            let people = recipients(&record.order);
            people.iter().any(|p| p == owner) && people.iter().any(|p| p == peer)
        })
    }
    pub(crate) fn participants(&self) -> BTreeSet<String> {
        self.records
            .values()
            .flat_map(|record| recipients(&record.order))
            .collect()
    }
    pub fn views(&self, owner: &str, now: u64) -> Vec<OrderView> {
        let mut result: Vec<_> =
            self.records
                .values()
                .map(|r| {
                    let fresh = r
                        .order
                        .shipment
                        .location
                        .as_ref()
                        .is_some_and(|p| now >= p.at && now - p.at < LOCATION_TTL);
                    let mut order = r.order.clone();
                    if !fresh {
                        order.shipment.location = None;
                    }
                    OrderView {
                        source_order_id: r.source_order_id.clone(),
                        delivery_order_id: r.delivery_order_id.clone(),
                        display_price: None,
                        role: role(&order, owner).map(str::to_string),
                        order,
                        archived: r.archived,
                        sync: if self.jobs.iter().any(|job| {
                            job.order_id == r.order.id && self.can_publish_at(&job.id, now)
                        }) {
                            "queued"
                        } else {
                            "sent"
                        }
                        .into(),
                        location_fresh: fresh,
                    }
                })
                .collect();
        result.sort_by(|a, b| {
            b.order
                .updated_at
                .cmp(&a.order.updated_at)
                .then(a.order.id.cmp(&b.order.id))
        });
        result
    }
    pub fn request(
        &mut self,
        listing: &crate::model::Listing,
        quantity: u16,
        note: &str,
        owner: &str,
        device: &str,
        now: u64,
    ) -> Result<String> {
        self.request_with_delivery(listing, quantity, note, None, owner, device, now)
    }
    #[allow(clippy::too_many_arguments)] // Keep request data and authenticated owner/device explicit.
    pub fn request_with_delivery(
        &mut self,
        listing: &crate::model::Listing,
        quantity: u16,
        note: &str,
        delivery: Option<DeliveryRequest>,
        owner: &str,
        device: &str,
        now: u64,
    ) -> Result<String> {
        require(
            listing.side == "offer"
                && listing.status != "sold"
                && listing.expires_at.is_none_or(|at| at > now),
            "Choose an available selling listing",
        )?;
        let order = snapshot_with_mint(
            Order {
                payment: None,
                pickup_authorization: None,
                delivery_request: delivery,
                id: format!("{owner}:{}", Uuid::new_v4()),
                buyer: owner.into(),
                seller: listing.author.clone(),
                items: vec![OrderItem {
                    id: listing.id.clone(),
                    title: listing.title.clone(),
                    price: listing.price.clone(),
                    currency: listing.currency.clone(),
                    quantity,
                }],
                note: note.into(),
                status: OrderStatus::Requested,
                created_at: now,
                updated_at: now,
                shipment: Shipment::default(),
                route_id: String::new(),
            },
            self.developer_mint.as_deref(),
        )?;
        let id = order.id.clone();
        self.local(&id, "request", json!(order), owner, device, now)?;
        Ok(id)
    }
    /// Explicit test-fixture policy only; normal native constructors never enable HTTP mints.
    pub fn set_developer_mint(&mut self, mint: Option<&str>) -> Result<()> {
        self.developer_mint = mint.map(local_mint).transpose()?;
        Ok(())
    }
    pub fn request_delivery(
        &mut self,
        source_id: &str,
        listing: &crate::model::Listing,
        destination: DeliveryPlace,
        owner: &str,
        device: &str,
        now: u64,
    ) -> Result<String> {
        let source = self.records.get(source_id).ok_or("Order not found")?;
        require(
            source.order.buyer == owner
                && matches!(
                    source.order.status,
                    OrderStatus::Accepted | OrderStatus::InTransit
                ),
            "Choose your accepted product order",
        )?;
        require(
            source.delivery_order_id.is_none(),
            "Delivery has already been requested",
        )?;
        require(
            source.order.delivery_request.is_none()
                && !source
                    .order
                    .shipment
                    .stops
                    .iter()
                    .any(|stop| stop.courier_pubkey.is_some()),
            "Choose a product pickup shared only with its merchant",
        )?;
        let pickup = source
            .order
            .shipment
            .stops
            .first()
            .ok_or("The merchant must provide a pickup place first")?;
        require(
            listing.author != source.order.seller,
            "Choose a separate delivery service",
        )?;
        let reference = Uuid::new_v4().to_string();
        let delivery = DeliveryRequest {
            pickup: DeliveryPlace {
                label: pickup.label.clone(),
                address: pickup.address.clone(),
                coordinates: pickup.coordinates,
            },
            destination,
            collection: Some(Collection {
                merchant: source.order.seller.clone(),
                reference: reference.clone(),
            }),
        };
        delivery_request(&delivery)?;
        let mut next = self.clone();
        let id = next.request_with_delivery(listing, 1, "", Some(delivery), owner, device, now)?;
        next.local(
            source_id,
            "pickup",
            json!(PickupAuthorization {
                courier_pubkey: listing.author.clone(),
                reference
            }),
            owner,
            device,
            now,
        )?;
        next.records
            .get_mut(source_id)
            .ok_or("Order not found")?
            .delivery_order_id = Some(id.clone());
        next.records
            .get_mut(&id)
            .ok_or("Order not found")?
            .source_order_id = Some(source_id.into());
        *self = next;
        Ok(id)
    }
    pub fn update(
        &mut self,
        id: &str,
        patch: Value,
        owner: &str,
        device: &str,
        now: u64,
    ) -> Result<()> {
        let (action, payload) = if let Some(value) = patch.get("payment") {
            (
                "payment",
                json!(payment(
                    parse(value.clone())?,
                    self.developer_mint.as_deref()
                )?),
            )
        } else if let Some(value) = patch.get("pickupAuthorization") {
            if !value.is_null() {
                pickup_authorization(&parse(value.clone())?)?;
            }
            ("pickup", value.clone())
        } else if let Some(location) = patch.get("location") {
            if !location.is_null() {
                let stop = location
                    .get("stopId")
                    .and_then(Value::as_str)
                    .ok_or("Missing delivery stop")?;
                require(text(stop, 80, false), "Invalid delivery stop")?;
                let point: [f64; 2] =
                    parse(location.get("coordinates").cloned().unwrap_or(Value::Null))?;
                require(coordinates(point), "Invalid map location")?;
                ("location", json!({"stopId":stop,"coordinates":point}))
            } else {
                ("location", Value::Null)
            }
        } else if patch.get("stopId").is_some() {
            (
                "stop",
                json!({"stopId":patch["stopId"],"status":patch["status"]}),
            )
        } else if let Some(shipment) = patch.get("shipment") {
            let mut shipment: Shipment = parse(shipment.clone())?;
            for stop in &mut shipment.stops {
                if let Some(courier) = &mut stop.courier_pubkey {
                    *courier = PublicKey::parse(&*courier)
                        .map_err(|_| "Invalid courier profile")?
                        .to_hex();
                }
            }
            ("route", json!(wire_shipment(shipment)?))
        } else if let Some(status) = patch.get("status") {
            ("status", json!({"status":status}))
        } else {
            return Err("Choose an order update".into());
        };
        self.local(id, action, payload, owner, device, now)
    }
    fn local(
        &mut self,
        id: &str,
        action: &str,
        payload: Value,
        owner: &str,
        device: &str,
        now: u64,
    ) -> Result<()> {
        let previous = self.records.get(id);
        let mut event = Envelope {
            v: 1,
            id: id.into(),
            op_id: Uuid::new_v4().to_string(),
            seq: previous
                .and_then(|r| r.clocks.get(&format!("{owner}:{device}")))
                .copied()
                .unwrap_or(0)
                + 1,
            at: now,
            action: action.into(),
            payload,
            snapshot: None,
            route_id: None,
        };
        if action == "route" {
            let mut order = previous.ok_or("Order not found")?.order.clone();
            order.shipment = parse(event.payload.clone())?;
            order.route_id = event.op_id.clone();
            event.snapshot = Some(order);
        }
        if matches!(action, "stop" | "location") {
            event.route_id = Some(previous.ok_or("Order not found")?.order.route_id.clone());
        }
        let (record, _) = apply_with_mint(
            previous,
            &event,
            owner,
            device,
            owner,
            now,
            self.developer_mint.as_deref(),
        )?;
        if matches!(role(&record.order, owner), Some("buyer" | "seller")) && action != "location" {
            event.snapshot = Some(snapshot_with_mint(
                record.order.clone(),
                self.developer_mint.as_deref(),
            )?);
        }
        require(
            previous.is_some() || self.records.len() < MAX_ORDERS,
            "The local order limit has been reached",
        )?;
        let peers: Vec<_> = recipients(&record.order)
            .into_iter()
            .filter(|p| p != owner)
            .collect();
        let retired: BTreeSet<_> = self
            .jobs
            .iter()
            .filter(|j| {
                j.order_id == id
                    && (!peers.contains(&j.recipient)
                        || (j.action == "location"
                            && (action == "location" || record.order.status.terminal())))
            })
            .map(|j| j.id.clone())
            .collect();
        require(
            self.blocked.len() + retired.len() <= 4096
                && self.jobs.len() - retired.len() + peers.len() <= MAX_JOBS,
            "The private delivery queue is full",
        )?;
        let wire = serde_json::to_string(&event).map_err(|_| "Invalid order update")?;
        require(wire.len() <= 24_000, "Order details are too large")?;
        let mut jobs = Vec::new();
        let mut ephemeral = Vec::new();
        for peer in peers {
            let mut rumor = UnsignedEvent::from_json(json!({"kind":14,"pubkey":device,"created_at":now,"content":message_text(&event,&record.order),"tags":[["p",peer],[ORDER_TAG,"1",wire],["ms",(now*1000).to_string()]]}).to_string()).map_err(|_| "Invalid private order message")?;
            if action == "location" && !event.payload.is_null() {
                rumor.tags.push(
                    nostr::Tag::parse([
                        "expiration",
                        &now.saturating_add(LOCATION_TTL).to_string(),
                    ])
                    .map_err(|_| "Invalid location expiry")?,
                );
            }
            rumor.ensure_id();
            if action == "location" {
                ephemeral.push(Ephemeral {
                    id: rumor.id.ok_or("Missing location identity")?.to_hex(),
                    order_id: id.into(),
                    op_id: event.op_id.clone(),
                    expires_at: if event.payload.is_null() {
                        0
                    } else {
                        now.saturating_add(LOCATION_TTL)
                    },
                });
            }
            jobs.push(Job {
                id: rumor.id.ok_or("Missing order message identity")?.to_hex(),
                order_id: id.into(),
                recipient: peer,
                rumor,
                action: action.into(),
                handed: false,
            });
        }
        require(
            self.ephemeral.len() + ephemeral.len() <= 4096,
            "The private tracking queue is full",
        )?;
        self.ephemeral.extend(ephemeral);
        self.jobs.retain(|j| !retired.contains(&j.id));
        self.blocked.extend(retired);
        self.jobs.extend(jobs);
        self.records.insert(id.into(), record);
        Ok(())
    }
    pub fn archive(&mut self, id: &str, archived: bool) -> Result<()> {
        self.records.get_mut(id).ok_or("Order not found")?.archived = archived;
        Ok(())
    }
    pub fn receive(
        &mut self,
        rumor: &UnsignedEvent,
        sender: &str,
        device: &str,
        owner: &str,
        now: u64,
    ) -> Option<(String, bool)> {
        let event = decode(rumor)?;
        let previous = self.records.get(&event.id);
        let applied = apply_with_mint(
            previous,
            &event,
            sender,
            device,
            owner,
            now,
            self.developer_mint.as_deref(),
        );
        let Ok((mut record, changed)) = applied else {
            if previous.is_none()
                && !matches!(event.action.as_str(), "request" | "location")
                && event.at <= now.saturating_add(300)
                && self.pending.len() < 64
                && !self.pending.iter().any(|p| p.event.op_id == event.op_id)
                && hex(sender)
                && hex(device)
                && event.v == 1
                && uuid(&event.op_id)
                && (1..=1_000_000_000).contains(&event.seq)
            {
                let claimed =
                    snapshot_with_mint(event.snapshot.clone()?, self.developer_mint.as_deref())
                        .ok()?;
                if claimed.id == event.id
                    && ((sender == claimed.seller && owner == claimed.buyer)
                        || (sender == claimed.buyer
                            && owner == claimed.seller
                            && event.action == "status"
                            && event.payload["status"] == "cancelled"))
                {
                    self.pending.push(Pending {
                        event,
                        sender: sender.into(),
                        device: device.into(),
                    });
                }
            }
            return None;
        };
        if !changed || (previous.is_none() && self.records.len() >= MAX_ORDERS) {
            return None;
        }
        let mut pending: Vec<_> = self
            .pending
            .iter()
            .filter(|p| p.event.id == event.id)
            .cloned()
            .collect();
        pending.sort_by(|a, b| {
            a.event
                .at
                .cmp(&b.event.at)
                .then(a.event.seq.cmp(&b.event.seq))
                .then(a.event.op_id.cmp(&b.event.op_id))
        });
        for item in pending {
            if let Ok((next, _)) = apply_with_mint(
                Some(&record),
                &item.event,
                &item.sender,
                &item.device,
                owner,
                now,
                self.developer_mint.as_deref(),
            ) {
                record = next;
            }
        }
        self.pending.retain(|p| p.event.id != event.id);
        if record.order.status.terminal() {
            let retired = self
                .jobs
                .iter()
                .filter(|job| job.order_id == event.id && job.action == "location")
                .map(|job| job.id.clone())
                .collect::<Vec<_>>();
            self.blocked.extend(retired);
            self.jobs
                .retain(|job| job.order_id != event.id || job.action != "location");
        }
        self.records.insert(event.id.clone(), record);
        Some((event.id, event.action == "location"))
    }
    pub(crate) fn can_publish(&self, id: &str) -> bool {
        self.can_publish_at(id, crate::listing::now())
    }
    fn can_publish_at(&self, id: &str, now: u64) -> bool {
        if self.blocked.contains(id) {
            return false;
        }
        let Some(item) = self.ephemeral.iter().find(|item| item.id == id) else {
            return true;
        };
        let Some(record) = self.records.get(&item.order_id) else {
            return false;
        };
        !record.order.status.terminal()
            && self
                .ephemeral
                .iter()
                .rev()
                .find(|other| other.order_id == item.order_id)
                .is_some_and(|latest| latest.op_id == item.op_id)
            && (item.expires_at == 0 || now < item.expires_at)
    }
    pub(crate) fn prune(&mut self, now: u64) {
        let retired = self
            .jobs
            .iter()
            .filter(|job| job.action == "location" && !self.can_publish_at(&job.id, now))
            .map(|job| job.id.clone())
            .collect::<BTreeSet<_>>();
        self.jobs.retain(|job| !retired.contains(&job.id));
    }
    pub(crate) fn sent(&mut self, id: &str, recipient: &str) {
        self.jobs.retain(|j| j.id != id || j.recipient != recipient);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn listing(seller: &str) -> crate::model::Listing {
        serde_json::from_value(json!({"id":format!("{seller}:lamp"),"author":seller,"title":"Lamp","description":"","side":"offer","price":"12","currency":"EUR","location":"","category":"goods","image_url":null,"created_at":1000,"expires_at":null,"status":"active","saved":false,"mine":false,"delivery":"sent","relevance":null})).unwrap()
    }
    fn take(book: &OrderBook, action: &str, recipient: &str) -> UnsignedEvent {
        book.jobs
            .iter()
            .rev()
            .find(|j| j.action == action && j.recipient == recipient)
            .unwrap()
            .rumor
            .clone()
    }
    fn receive(book: &mut OrderBook, event: &UnsignedEvent, sender: &str, owner: &str) -> bool {
        book.receive(event, sender, sender, owner, 1000).is_some()
    }
    #[test]
    fn stopping_location_after_completion_is_safe_and_role_scoped() {
        let buyer = "a".repeat(64);
        let seller = "b".repeat(64);
        let courier = "c".repeat(64);
        let mut b = OrderBook::default();
        let mut s = OrderBook::default();
        let mut c = OrderBook::default();
        let id = b
            .request(&listing(&seller), 1, "", &buyer, &buyer, 1000)
            .unwrap();
        assert!(receive(
            &mut s,
            &take(&b, "request", &seller),
            &buyer,
            &seller
        ));
        s.update(&id, json!({"status":"accepted"}), &seller, &seller, 1000)
            .unwrap();
        s.update(
            &id,
            json!({"shipment":{"stops":[{"id":"pickup","label":"Shop","courierPubkey":courier}]}}),
            &seller,
            &seller,
            1000,
        )
        .unwrap();
        assert!(receive(
            &mut c,
            &take(&s, "route", &courier),
            &seller,
            &courier
        ));
        s.update(&id, json!({"status":"delivered"}), &seller, &seller, 1000)
            .unwrap();
        assert!(receive(
            &mut c,
            &take(&s, "status", &courier),
            &seller,
            &courier
        ));
        c.update(&id, json!({"location":null}), &courier, &courier, 1000)
            .unwrap();
        s.update(&id, json!({"location":null}), &seller, &seller, 1000)
            .unwrap();
        assert!(
            c.update(
                &id,
                json!({"stopId":"pickup","status":"arrived"}),
                &courier,
                &courier,
                1000
            )
            .is_err()
        );
        assert!(
            c.update(
                &id,
                json!({"location":{"stopId":"pickup","coordinates":[25.,61.]}}),
                &courier,
                &courier,
                1000
            )
            .is_err()
        );
        assert!(
            s.update(&id, json!({"location":null}), &buyer, &buyer, 1000)
                .is_err()
        );
    }
    #[test]
    fn route_reordering_roles_device_clocks_and_fresh_positions() {
        let buyer = "a".repeat(64);
        let seller = "b".repeat(64);
        let courier = "c".repeat(64);
        let outsider = "d".repeat(64);
        let mut b = OrderBook::default();
        let mut s = OrderBook::default();
        let mut c = OrderBook::default();
        let id = b
            .request(&listing(&seller), 2, "Please call", &buyer, &buyer, 1000)
            .unwrap();
        let request = take(&b, "request", &seller);
        assert!(!receive(&mut s, &request, &outsider, &seller));
        assert!(receive(&mut s, &request, &buyer, &seller));
        s.update(&id, json!({"status":"accepted"}), &seller, &seller, 1000)
            .unwrap();
        let accepted = take(&s, "status", &buyer);
        s.update(&id,json!({"shipment":{"stops":[{"id":"pickup","label":"Shop","address":"Private address","coordinates":[24.,60.],"courierPubkey":courier}]}}),&seller,&seller,1000).unwrap();
        let route = take(&s, "route", &buyer);
        assert!(receive(&mut b, &route, &seller, &buyer));
        assert!(!receive(&mut b, &accepted, &seller, &buyer));
        assert_eq!(b.views(&buyer, 1000)[0].order.status, OrderStatus::Accepted);
        assert!(!receive(
            &mut c,
            &take(&s, "route", &courier),
            &buyer,
            &courier
        ));
        assert!(receive(
            &mut c,
            &take(&s, "route", &courier),
            &seller,
            &courier
        ));
        assert!(
            c.update(&id, json!({"status":"delivered"}), &courier, &courier, 1000)
                .is_err()
        );
        c.update(
            &id,
            json!({"stopId":"pickup","status":"arrived"}),
            &courier,
            &courier,
            1000,
        )
        .unwrap();
        assert!(receive(&mut b, &take(&c, "stop", &buyer), &courier, &buyer));
        c.update(
            &id,
            json!({"location":{"stopId":"pickup","coordinates":[25.,61.]}}),
            &courier,
            &courier,
            1000,
        )
        .unwrap();
        let mut location = decode(&take(&c, "location", &buyer)).unwrap();
        location.op_id = Uuid::new_v4().to_string();
        location.seq += 1;
        location.action = "location".into();
        location.payload = json!({"stopId":"pickup","coordinates":[25.,61.]});
        let current = b.records.get(&id).unwrap();
        let (position, _) =
            apply(Some(current), &location, &courier, &courier, &buyer, 1000).unwrap();
        b.records.insert(id.clone(), position);
        assert!(b.views(&buyer, 1119)[0].location_fresh);
        assert!(b.views(&buyer, 1120)[0].order.shipment.location.is_none());
        assert!(
            !apply(
                b.records.get(&id),
                &Envelope {
                    seq: 3,
                    at: 880,
                    ..location.clone()
                },
                &courier,
                &courier,
                &buyer,
                1000
            )
            .unwrap()
            .1
        );
        let mut removed = route.clone();
        let mut changed = decode(&removed).unwrap();
        changed.seq = 3;
        changed.op_id = Uuid::new_v4().to_string();
        changed.payload["stops"][0]["courierPubkey"] = json!(outsider);
        changed.snapshot.as_mut().unwrap().shipment.stops[0].courier_pubkey =
            Some(outsider.clone());
        removed.tags = nostr::Tags::parse(vec![vec![
            ORDER_TAG.to_string(),
            "1".into(),
            serde_json::to_string(&changed).unwrap(),
        ]])
        .unwrap();
        assert!(receive(&mut b, &removed, &seller, &buyer));
        assert!(
            apply(
                b.records.get(&id),
                &Envelope { seq: 4, ..location },
                &courier,
                &courier,
                &buyer,
                1000
            )
            .is_err()
        );
    }
    #[test]
    fn dependent_status_waits_for_authentic_request_and_clocks_are_per_device() {
        let buyer = "a".repeat(64);
        let seller = "b".repeat(64);
        let sibling = "c".repeat(64);
        let mut b = OrderBook::default();
        let mut s = OrderBook::default();
        let mut sibling_book = OrderBook::default();
        let id = b
            .request(&listing(&seller), 1, "", &buyer, &buyer, 1000)
            .unwrap();
        let request = take(&b, "request", &seller);
        receive(&mut s, &request, &buyer, &seller);
        s.update(&id, json!({"status":"accepted"}), &seller, &seller, 1000)
            .unwrap();
        let accepted = take(&s, "status", &buyer);
        assert!(!receive(&mut sibling_book, &accepted, &seller, &buyer));
        assert!(sibling_book.views(&buyer, 1000).is_empty());
        assert!(receive(&mut sibling_book, &request, &buyer, &buyer));
        assert_eq!(
            sibling_book.views(&buyer, 1000)[0].order.status,
            OrderStatus::Accepted
        );
        sibling_book
            .update(&id, json!({"status":"cancelled"}), &buyer, &sibling, 1000)
            .unwrap();
        let cancel = take(&sibling_book, "status", &seller);
        assert!(
            s.receive(&cancel, &buyer, &sibling, &seller, 1000)
                .is_some()
        );
        assert_eq!(
            s.views(&seller, 1000)[0].order.status,
            OrderStatus::Cancelled
        );
        let serialized = serde_json::to_string(&sibling_book).unwrap();
        let restored: OrderBook = serde_json::from_str(&serialized).unwrap();
        assert_eq!(restored.views(&buyer, 1000)[0].sync, "queued");
    }
    #[test]
    fn separate_checkout_keeps_product_private_and_links_only_local_records() {
        let buyer = "a".repeat(64);
        let merchant = "b".repeat(64);
        let courier = "c".repeat(64);
        let mut b = OrderBook::default();
        let mut m = OrderBook::default();
        let mut c = OrderBook::default();
        let product = b
            .request(
                &listing(&merchant),
                1,
                "Private parcel contents",
                &buyer,
                &buyer,
                1000,
            )
            .unwrap();
        receive(&mut m, &take(&b, "request", &merchant), &buyer, &merchant);
        m.update(&product,json!({"payment":{"mint":"https://testnut.cashu.space/","amount":"0016","unit":"sat","status":"requested"}}),&merchant,&merchant,1000).unwrap();
        m.update(&product,json!({"payment":{"mint":"https://testnut.cashu.space","amount":"16","unit":"sat","status":"received"}}),&merchant,&merchant,1000).unwrap();
        m.update(
            &product,
            json!({"status":"accepted"}),
            &merchant,
            &merchant,
            1000,
        )
        .unwrap();
        m.update(&product,json!({"shipment":{"stops":[{"id":"shop","label":"Shop","address":"Private merchant pickup","coordinates":[24.0,60.0]}]}}),&merchant,&merchant,1000).unwrap();
        // Later seller snapshots must recover its payment even if earlier operations arrived late.
        receive(&mut b, &take(&m, "route", &buyer), &merchant, &buyer);
        assert_eq!(
            b.records[&product].order.payment.as_ref().unwrap().status,
            PaymentStatus::Received
        );
        let destination = DeliveryPlace {
            label: "Home".into(),
            address: "Private destination".into(),
            coordinates: Some([25.0, 61.0]),
        };
        let delivery = b
            .request_delivery(
                &product,
                &listing(&courier),
                destination.clone(),
                &buyer,
                &buyer,
                1000,
            )
            .unwrap();
        assert_eq!(
            b.records[&product].delivery_order_id.as_deref(),
            Some(delivery.as_str())
        );
        assert_eq!(
            b.records[&delivery].source_order_id.as_deref(),
            Some(product.as_str())
        );
        assert!(
            b.jobs
                .iter()
                .filter(|job| job.order_id == product)
                .all(|job| job.recipient == merchant)
        );
        let request = take(&b, "request", &courier);
        let wire = request.as_json();
        assert!(!wire.contains("Private parcel contents"));
        assert!(!wire.contains(&product));
        assert!(!wire.contains("sourceOrderId"));
        assert!(receive(&mut c, &request, &buyer, &courier));
        assert_eq!(c.records.len(), 1);
        assert!(c.records[&delivery].source_order_id.is_none());
        let auth = take(&b, "pickup", &merchant);
        assert!(!auth.as_json().contains("Private destination"));
        assert!(receive(&mut m, &auth, &buyer, &merchant));
        assert!(m.records[&product].delivery_order_id.is_none());
        assert_eq!(
            m.records[&product]
                .order
                .pickup_authorization
                .as_ref()
                .unwrap()
                .courier_pubkey,
            courier
        );
        assert!(
            b.request_delivery(
                &product,
                &listing(&courier),
                destination,
                &buyer,
                &buyer,
                1000
            )
            .is_err()
        );
        let restored: OrderBook =
            serde_json::from_str(&serde_json::to_string(&b).unwrap()).unwrap();
        assert_eq!(restored.records[&delivery].source_order_id, Some(product));
    }
    #[test]
    fn payment_ownership_irreversibility_immutable_delivery_and_explicit_local_policy() {
        let buyer = "a".repeat(64);
        let seller = "b".repeat(64);
        let mut b = OrderBook::default();
        let mut s = OrderBook::default();
        let context = DeliveryRequest {
            pickup: DeliveryPlace {
                label: "Shop".into(),
                address: "Pickup".into(),
                coordinates: None,
            },
            destination: DeliveryPlace {
                label: "Home".into(),
                address: "Destination".into(),
                coordinates: None,
            },
            collection: None,
        };
        let id = b
            .request_with_delivery(
                &listing(&seller),
                1,
                "",
                Some(context.clone()),
                &buyer,
                &buyer,
                1000,
            )
            .unwrap();
        receive(&mut s, &take(&b, "request", &seller), &buyer, &seller);
        let requested = json!({"payment":{"mint":"https://testnut.cashu.space","amount":"8","unit":"sat","status":"requested"}});
        assert!(
            b.update(&id, requested.clone(), &buyer, &buyer, 1000)
                .is_err()
        );
        s.update(&id, requested, &seller, &seller, 1000).unwrap();
        s.update(&id, json!({"status":"accepted"}), &seller, &seller, 1000)
            .unwrap();
        assert_eq!(
            s.records[&id].order.payment.as_ref().unwrap().status,
            PaymentStatus::Requested
        );
        let mut changed = decode(&take(&s, "status", &buyer)).unwrap();
        changed
            .snapshot
            .as_mut()
            .unwrap()
            .delivery_request
            .as_mut()
            .unwrap()
            .destination
            .address = "Changed".into();
        assert!(apply(b.records.get(&id), &changed, &seller, &seller, &buyer, 1000).is_err());
        s.update(&id,json!({"payment":{"mint":"https://testnut.cashu.space","amount":"8","unit":"sat","status":"received"}}),&seller,&seller,1000).unwrap();
        assert!(s.update(&id,json!({"payment":{"mint":"https://testnut.cashu.space","amount":"8","unit":"sat","status":"requested"}}),&seller,&seller,1000).is_err());
        assert!(s.update(&id,json!({"payment":{"mint":"https://testnut.cashu.space","amount":"9","unit":"sat","status":"received"}}),&seller,&seller,1000).is_err());
        let local = json!({"payment":{"mint":"http://127.0.0.1:3338","amount":"8","unit":"sat","status":"requested"}});
        let other = b
            .request(&listing(&seller), 1, "", &buyer, &buyer, 1000)
            .unwrap();
        receive(&mut s, &take(&b, "request", &seller), &buyer, &seller);
        assert!(
            s.update(&other, local.clone(), &seller, &seller, 1000)
                .is_err()
        );
        s.set_developer_mint(Some("http://127.0.0.1:3338")).unwrap();
        s.update(&other, local, &seller, &seller, 1000).unwrap();
        assert!(
            s.set_developer_mint(Some("http://192.168.1.1:3338"))
                .is_err()
        );
    }
    #[test]
    fn live_coordinates_coalesce_expire_stop_and_never_retain_prior_plaintext() {
        let buyer = "a".repeat(64);
        let seller = "b".repeat(64);
        let mut b = OrderBook::default();
        let mut s = OrderBook::default();
        let id = b
            .request(&listing(&seller), 1, "", &buyer, &buyer, 1000)
            .unwrap();
        receive(&mut s, &take(&b, "request", &seller), &buyer, &seller);
        s.update(&id, json!({"status":"accepted"}), &seller, &seller, 1000)
            .unwrap();
        s.update(
            &id,
            json!({"shipment":{"stops":[{"id":"pickup","label":"Shop"}]}}),
            &seller,
            &seller,
            1000,
        )
        .unwrap();
        s.update(
            &id,
            json!({"location":{"stopId":"pickup","coordinates":[111.12345,22.54321]}}),
            &seller,
            &seller,
            1000,
        )
        .unwrap();
        let old = take(&s, "location", &buyer);
        assert!(s.can_publish_at(&old.id.unwrap().to_hex(), 1000));
        s.update(
            &id,
            json!({"location":{"stopId":"pickup","coordinates":[112.12345,23.54321]}}),
            &seller,
            &seller,
            1001,
        )
        .unwrap();
        let latest = take(&s, "location", &buyer);
        assert!(!s.can_publish_at(&old.id.unwrap().to_hex(), 1001));
        assert!(s.can_publish_at(&latest.id.unwrap().to_hex(), 1120));
        assert!(!s.can_publish_at(&latest.id.unwrap().to_hex(), 1121));
        assert_eq!(
            s.jobs.iter().filter(|job| job.action == "location").count(),
            1
        );
        assert!(!serde_json::to_string(&s).unwrap().contains("111.12345"));
        assert_eq!(latest.tags.expiration().unwrap().as_secs(), 1121);
        s.update(&id, json!({"location":null}), &seller, &seller, 1002)
            .unwrap();
        assert!(!s.can_publish_at(&latest.id.unwrap().to_hex(), 1002));
        assert!(!serde_json::to_string(&s).unwrap().contains("112.12345"));
        assert!(s.records[&id].order.shipment.location.is_none());
        let mut restored: OrderBook =
            serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert!(!restored.can_publish_at(&old.id.unwrap().to_hex(), 1002));
        restored.prune(1200);
    }
    #[test]
    fn bound_payloads_and_conservative_identity() {
        let buyer = "a".repeat(64);
        let seller = "b".repeat(64);
        let mut b = OrderBook::default();
        assert!(
            b.request(&listing(&seller), 0, "", &buyer, &buyer, 1000)
                .is_err()
        );
        assert!(
            b.request(
                &listing(&seller),
                1,
                &"x".repeat(2001),
                &buyer,
                &buyer,
                1000
            )
            .is_err()
        );
        assert!(
            b.request(&listing(&buyer), 1, "", &buyer, &buyer, 1000)
                .is_err()
        );
        let id = b
            .request(&listing(&seller), 1, "", &buyer, &buyer, 1000)
            .unwrap();
        assert!(
            b.update(&id, json!({"shipment":{"stops":[]}}), &buyer, &buyer, 1000)
                .is_err()
        );
        assert!(
            wire_shipment(Shipment {
                stops: (0..13)
                    .map(|i| ShipmentStop {
                        id: i.to_string(),
                        label: String::new(),
                        address: String::new(),
                        status: StopStatus::Pending,
                        coordinates: None,
                        courier_pubkey: None
                    })
                    .collect(),
                ..Shipment::default()
            })
            .is_err()
        );
    }
}

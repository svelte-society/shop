# Styria API contract record

- Official source: <https://styriashirts.eu/api-documentation>
- Retrieved: 2026-07-16 (Europe/Stockholm)
- Published `article:modified_time`: `2023-07-18T10:38:40+02:00`
- Contract result: the public create and signing semantics remain compatible with the approved Phase 3 plan. No plan or specification amendment is required.

## Authentication and formats

Every request includes the account App ID and a `Signature`. The documentation says the signature is SHA-1 of the request body followed immediately by the account Secret Key. For POST, “request body” means the entire request content. For GET, it means everything after `?`, excluding the `Signature` parameter. The adapter therefore signs the exact UTF-8 JSON string sent for POST and a deterministic, encoded query string without `Signature` for GET. The hexadecimal digest is lower-case.

The public examples spell the parameter `AppId`, while the prose calls it `AppID`; the adapter follows the examples and uses `AppId`. POST JSON uses `Content-Type: application/json`. GET requests select JSON explicitly with `format=json`; the documentation says omitted GET format defaults to `JSN`, which appears to be a documentation typo.

The authentication SHA-1 is separate from the application's SHA-256 hash of recursively canonicalized payload JSON used to bind administrator approvals.

## Order endpoints

- `GET /api/orders.php`: list orders. Supported public filters are `ids`, `limit` (default 50, maximum 250), `page` (default 1), `since_id`, `created_at_min`, `created_at_max`, and `status`. The public contract does not document an `external_id` filter, so the adapter pages with `limit=250` and filters exact `external_id` values locally.
- `GET /api/order.php`: retrieve one order by `id`.
- `GET /api/orders/count.php`: count orders, with `since_id`, creation-date, and status filters.
- `POST /api/orders.php`: create an order.
- `DELETE /api/orders.php`: delete an unpaid order. This MVP adapter does not expose deletion.

## Documented statuses

The order property and list/count filters document: `received`, `in progress`, `paid`, `stock allocation`, `printing`, `quality control`, `refunded`, and `internal order query`. The endpoint tables repeat `refunded`; it is recorded here once. `deleted` is a separate order property.

## Create fields

The writable order data relevant to this adapter is:

- `external_id`: documented as a writable unique internal customer-order identifier, although it is omitted from the JSON create example.
- `brandName`: used by the JSON create example. The property table separately calls the order-level field `brand`; this adapter follows the create example and the approved project contract, pending account smoke verification.
- `comment`.
- `shipping_address`: `firstName`, `lastName`, `company`, `address1`, optional `address2`, `city`, `county`, `postcode`, full country name in `country`, and `phone1`. The broader property example also shows optional `phone2`, `phone3`, and `vatNumber`; this adapter does not send them.
- `shipping.shippingMethod`: the public values are `regular`, `recorded`, `courier`, and `collection`; the approved project payload uses `courier`.
- `items[]`: `pn`, `quantity`, `retailPrice`, `description`, placement-to-URL `designs`, and optional placement-to-URL `mockups`. Product metadata uses the same exact Styria placement for the artwork, mockup, and confirmed thread-colour list. The immutable checkout snapshot preserves those values; the adapter sends the mockup and adds the confirmed thread-colour names and hex values to the item description. The public schema also describes optional `title`, item `brandName`, and `label`; this adapter does not send them.

## Public documentation and account-specific differences

The public page contains two internal inconsistencies: `brand` in the property table versus `brandName` in the create example, and omission of the otherwise writable `external_id` from that example. The approved project contract assumes `brandName` plus `external_id`; this is not a verified account-specific fact and remains pending the account smoke. The public documentation does not materially contradict that planned create shape.

The signed sandbox smoke subsequently confirmed that account responses return `designs` and `mockups` as arrays of `{ title, src }` records. The adapter accepts those response arrays and normalizes them to placement-to-URL records. Empty mockup arrays remain valid for legacy orders.

## Non-production signed smoke record

Signed list, detail, create, and unpaid-order deletion requests have now been exercised against the account sandbox. Do not record credentials, customer details, or raw returned order data here.

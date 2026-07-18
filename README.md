# Svelte Society Merch

Production-shaped SvelteKit storefront and fulfillment service for Svelte Society merchandise.
The application uses SQLite as its system of record and is deployed as exactly one adapter-node
process with a persistent `/data` volume.

## Local checks

```sh
pnpm install
pnpm test:unit
pnpm test:integration
pnpm playwright test
pnpm check
pnpm lint
pnpm build
bash tests/integration/docker-health.sh
```

The example environment deliberately keeps `STOREFRONT_ENABLED=false` and
`CHECKOUT_ENABLED=false`. Withdrawal-route testing additionally needs a fresh 32-byte base64
`WITHDRAWAL_DATA_KEY`; the generation command is documented in `.env.example` and
`docs/operations/coolify.md`.

## Operations

- [Coolify deployment](docs/operations/coolify.md)
- [Withdrawal operations](docs/operations/withdrawals.md)
- [Encrypted backup and restore](docs/operations/backup-restore.md)
- [Policy and seller review gate](docs/operations/policy-review.md)

Checkout remains blocked until the production configuration, qualified Swedish/EU legal review,
accounting approval, and all documented launch gates are complete. The withdrawal route can be
deployed and verified while both storefront and checkout remain off.

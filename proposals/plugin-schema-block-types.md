---
title: Block types in plugin schema access
type: rfc
status: proposed
authors:
  - Diogo Carneiro (@diogoascarneiro)
champion: Diogo Carneiro (@diogoascarneiro)
sponsor: null
discussions:
  - https://github.com/emdash-cms/emdash/discussions/XXX
created: 2026-11-20
---

# Block types in plugin schema access

## Summary

`ctx.schema.getCollection()` and `ctx.schema.listCollections()` return a read-only `blockTypes` list on each `blocks` field. Each entry holds the block type's slug, label, active version, and every retained version with the `slug`, `type`, `label`, `required`, `validation` and `options` of each field. Plugins that already hold `schema:read` get it with no change to their manifest. It works the same for trusted and sandboxed plugins, in requests and in queue consumers.

A block type that has no definition is left out of the list instead of making the read fail.

## Problem and user case

A plugin that reads a collection schema sees a `blocks` field as `type: "blocks"` with `validation.allowedTypes` and `validation.retiredTypes`. It can't see what those slugs mean: which versions exist, or which fields each version has and what type they are. A stored block carries only `_type`, `_version` and `_key`, so a plugin can't tell which of its values are text, URLs, images, selects or repeaters.

The data is already assembled. `expandCollectionBlockFields()` (`packages/core/src/schema/block-values.ts`) adds `blockTypes` and `blockTypeFingerprint` to `blocks` fields for the admin schema API, MCP, the admin manifest and generated types. Plugin schema access (`collectionToSchemaInfo()` in `packages/core/src/plugins/context.ts`) doesn't call it, and `FieldSchemaInfo` (`packages/core/src/plugins/types.ts`) has no property for it.

The first known consumer is a translation plugin. It translates entries into other locales with AI, from the content editor and in queued batch jobs, which run in a queue consumer with no browser. For a `blocks` field it must translate each block's `string`, `text` and `portableText` fields and the text sub-fields of repeaters. It must leave `url`, `image`, `file`, `select`, numbers and `anchor_id` alone, and keep `_type`, `_version` and `_key`. The block type definitions say which is which, per version.

Without the definitions, a site has three options, and each fails in a different way:

- List the text paths of every block type in plugin config. The list drifts when a block type gets a new version.
- Guess from value shapes. This translates URLs and IDs that are stored as strings.
- Send the expanded schema from the admin UI with each request. Queue consumers have no admin UI, and the server would trust schema data supplied by the client.
- Generate the config from `seed.json` at build time. This misses block types that were created or versioned through the schema API or MCP after the seed was applied.

Other plugins that rewrite or inspect block content by field type have the same problem. Examples are SEO checks, search indexing, alt-text audits for image fields, and content export.

No existing proposal, issue or Discussion covers this. [Blocks field redesign](blocks-field-redesign.md) defines the block types and does not mention plugin access. Discussion #337 introduced the blocks field. Discussion #3726 is about sandboxed plugins rendering their own Portable Text block types, which is a different surface.

## Example

A plugin with `schema:read` collects the translatable paths of a `pages` entry:

```ts
const pages = await ctx.schema.getCollection("pages");
const layout = pages?.fields.find((field) => field.slug === "layout");

const TEXT_TYPES = new Set(["string", "text", "portableText"]);

for (const block of entry.data.layout) {
	const type = layout?.blockTypes?.find((candidate) => candidate.slug === block._type);
	const version = type?.versions.find((candidate) => candidate.version === block._version);
	if (!version || version.unsupportedTypes) continue; // leave blocks we can't describe

	for (const field of version.fields) {
		if (field.slug === "anchor_id") continue;
		if (TEXT_TYPES.has(field.type)) translate(block, field.slug);
		if (field.type === "repeater") {
			for (const sub of field.validation?.subFields ?? []) {
				if (sub.type === "string" || sub.type === "text")
					translateRepeater(block, field.slug, sub.slug);
			}
		}
	}
}
```

For a `hero` block at version 1, `layout.blockTypes[0]` is:

```json
{
	"slug": "hero",
	"label": "Hero",
	"currentVersion": 1,
	"versions": [
		{
			"version": 1,
			"active": true,
			"fields": [
				{ "slug": "heading", "label": "Heading", "type": "string", "required": true },
				{ "slug": "link", "label": "Link", "type": "url", "required": false },
				{
					"slug": "items",
					"label": "Items",
					"type": "repeater",
					"required": false,
					"validation": {
						"subFields": [
							{ "slug": "title", "type": "string", "label": "Title" },
							{ "slug": "icon", "type": "select", "label": "Icon", "options": ["a", "b"] }
						]
					}
				}
			]
		}
	]
}
```

## Goals

- A plugin with `schema:read` can find the slug and type of every field in every retained version of every block type that a `blocks` field allows or has retired.
- It works for sandboxed plugins and in queue consumers, with no new capability and no browser.
- Plugins that don't read the new property see no change, and existing plugin schema reads never start failing because of it.
- `listCollections()` loads block types with a fixed number of queries, however many collections and `blocks` fields exist, and loads none when no collection has a `blocks` field.

## Non-goals

- Writing or creating block types from plugins.
- Telling a plugin which fields to translate, or any other policy. Core exposes types; plugins decide.
- Marking `anchor_id`. It is a slug convention that the admin uses as a layout hint, not a field type, so plugins match it by slug.
- Changing the admin schema API, MCP or generated types.
- Block type presentation data: `description`, `icon`, `category`, `source`, IDs and timestamps.
- A plugin hook for being told when block types change.
- Writing `defaultValue` into blocks. Plugins read blocks here, they don't create them, so the field is left out.
- Nested repeaters. Core's `RepeaterSubField` allows only flat field types, so `validation.subFields` is a flat list.

## Detailed design

### Shape

`FieldSchemaInfo` gains an optional property that is present only when `type` is `"blocks"`. Other field types never have it.

| Type                         | Property                                 | Notes                                                                                                                   |
| ---------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `FieldSchemaInfo`            | `blockTypes?: BlockTypeSchemaInfo[]`     | Always an array on a `blocks` field, empty when nothing resolves. Order follows `allowedTypes`, then `retiredTypes`.    |
| `BlockTypeSchemaInfo`        | `slug`, `label`, `currentVersion`        | `currentVersion` is the version new blocks use.                                                                         |
| `BlockTypeSchemaInfo`        | `versions: BlockTypeVersionSchemaInfo[]` | Every retained version in ascending order, so stored blocks at an older `_version` still have a definition.             |
| `BlockTypeVersionSchemaInfo` | `version`, `active`, `fingerprint`       | `active` is true for the version that matches `currentVersion`. `fingerprint` changes when the version's fields change. |
| `BlockTypeVersionSchemaInfo` | `fields: BlockFieldSchemaInfo[]`         | Empty when `unsupportedTypes` is set.                                                                                   |
| `BlockTypeVersionSchemaInfo` | `unsupportedTypes?`                      | `{ type, path }[]`. Present only when the stored version uses field types this runtime can't read.                      |
| `BlockFieldSchemaInfo`       | `slug`, `label`, `type`, `required`      | `type` is `BlockFieldType`, the same union the schema API uses.                                                         |
| `BlockFieldSchemaInfo`       | `validation?`, `options?`                | Passed through unchanged. Repeater sub-fields are in `validation.subFields`, as they are for collection fields.         |

The three new interfaces are exported from `emdash` and `emdash/plugins` beside `FieldSchemaInfo`.

The shape leaves out block type and version IDs, timestamps, `description`, `icon`, `category`, `source`, field `defaultValue`, and the field-level `blockTypeFingerprint`. Keeping the shape small leaves room to add properties later without a breaking change. `BlockTypeVersionSchemaInfo` gains `fingerprint: string` (the version's own fingerprint) so plugins can cache derived data.

### Block types that are missing or unreadable

`expandCollectionBlockFields()` calls `unsupported()` for a slug with no block type, which throws `UNSUPPORTED_FIELD_TYPE`. That suits the admin schema API and write paths, which must refuse to proceed. A plugin reading the schema has nothing to refuse, and a deleted or not-yet-seeded block type must not make `getCollection()` throw for every plugin on the site.

Plugin schema access therefore doesn't call it:

- A slug with no block type is omitted from `blockTypes`. A plugin can find it by comparing `validation.allowedTypes` and `validation.retiredTypes` with the slugs present, and should leave blocks of that type alone.
- A version that stores field types the runtime can't read keeps its entry, with `fields: []` and `unsupportedTypes` set. This mirrors the fail-closed handling in `BlockTypeRegistry`, which refuses to edit such a version. A plugin that reads `fields` and ignores `unsupportedTypes` sees an empty version and changes nothing, which is the safe outcome.

### Queries

`listCollections()` calls the existing `resolveBlockTypes()` once, after the collection and field queries, and only when some collection has a `blocks` field. That is the existing two-statement read of `_emdash_block_types` and `_emdash_block_type_versions`, whatever the number of collections or fields. `getCollection()` does the same for its one collection. Sites without `blocks` fields add no queries.

Plugin schema access isn't on the logged-out render path. The extra read runs only when a plugin calls it.

### Sandboxed plugins

Both sandbox bridges call `createSchemaAccess(db)` and return its result to the plugin: `packages/workerd/src/sandbox/bridge-handler.ts` serializes it as JSON, and the `PluginBridge` `WorkerEntrypoint` in `packages/cloudflare/src/sandbox/bridge.ts` returns it over Workers RPC. The new property is plain objects, arrays, strings, numbers and booleans, with no `undefined` values, `Map`s or class instances, so it crosses either boundary unchanged. The bridge type `CollectionSchemaInfo` carries the new type to sandboxed plugin code, so neither bridge changes.

### Capability

`schema:read` already exposes collection and field definitions, including field validation, to a plugin. Block type definitions have the same sensitivity: they are schema, not content. No capability is added, and the plugin manifest, `declaredAccess` and the marketplace permission descriptions stay as they are.

## Compatibility and migration

The change is additive. Existing properties keep their names, types and values. A plugin that ignores `blockTypes` behaves as before, and `blocks` fields on sites with no block types return `blockTypes: []`.

Plugins that spread or compare whole `FieldSchemaInfo` objects see a new property on `blocks` fields. The workerd and Cloudflare sandbox tests that stub `schema` return their own values and don't depend on the shape.

There is no stored-data change and no migration. The change needs a minor changeset for `emdash`, and `capabilities.mdx` and the plugin-authoring skill references (`skills/creating-plugins/references/content.md`) need a line each about the new property.

The property is part of the public plugin contract once it ships. Removing or renaming it later would be a breaking change, so the shape above is worth settling in review.

## Security and privacy

- **Authorization.** Only plugins that declare `schema:read` can reach it, by the same checks as today. Both bridge handlers already call `requireCapability(opts, "schema:read")`.
- **Exposed data.** Block type slugs, labels, versions and field definitions. These are administrator-authored schema. No content, user data or secrets are involved.
- **Hidden collections.** Plugin schema access already returns hidden collections with `hidden: true`. This proposal doesn't change that.
- **Untrusted input.** The property is built from stored schema rows through typed fields. It takes no plugin input.

## Performance

- Queries: zero extra for sites without `blocks` fields, and the existing two-statement block type read, once, for the others.
- Payload: the property repeats a block type under every `blocks` field that allows it. In a local measurement with 20 block types of four fields each, allowed by one `blocks` field in each of three collections, `listCollections()` returned about 23.8 KB and `getCollection()` for one of those collections about 7.9 KB. Repeaters and longer option lists make it larger. Sandboxed plugins pay that over the bridge on each call, so they should cache or call `getCollection()` for the one collection they need.
- No hot path changes.

## Failure handling

- A missing block type, or a version the runtime can't read, never makes a schema read fail. See [Block types that are missing or unreadable](#block-types-that-are-missing-or-unreadable).
- A database error in the block type read fails the schema call, as an error in the collection read does today.
- Block types can change between a plugin's schema read and its use of the result. A plugin that works from a long-lived copy should read again at the start of each job. The properties that describe a version don't change once the version exists, apart from presentation and compatible additive edits, which the registry applies in place.

## Verification

The prototype adds `packages/core/tests/integration/plugins/schema-block-types.test.ts`, which runs on each supported dialect through `describeEachDialect`. It checks that:

- `blocks` fields carry `blockTypes` with versions and field types, including repeater `validation.subFields`, and other field types don't;
- retired types and every retained version appear, with `active` and `currentVersion` correct after a breaking version is activated;
- a deleted block type is omitted and both `getCollection()` and `listCollections()` still succeed;
- a version with unreadable stored field types returns `fields: []` and `unsupportedTypes`;
- the result survives `JSON.parse(JSON.stringify(...))` unchanged, which is what the workerd bridge does (the Cloudflare bridge sends the same plain values over Workers RPC, which this test doesn't exercise);
- `listCollections()` reads `_emdash_block_types` once with three `blocks` fields in three collections, and reads none when no collection has one.

The two query-count tests fail when the code loads block types on every call or once per collection.

Run against the prototype: the new tests, `tests/integration/plugins`, `tests/integration/schema` and `tests/unit/plugins` in `packages/core`; the `@emdash-cms/sandbox-workerd` and `@emdash-cms/cloudflare` suites; `pnpm typecheck`; `pnpm lint:quick` with zero diagnostics.

Not yet covered, and needed before implementation: a test that calls `ctx.schema.getCollection()` for a `blocks` field from inside a real sandboxed plugin in the workerd sandbox and the Cloudflare sandbox, to confirm the property arrives through the bridge with its types intact.

## Rollout and implementation

One implementation pull request in `packages/core`: the types and their exports, the mapping in `createSchemaAccess()`, the tests above, a minor changeset, and the two documentation lines. Nothing needs a flag.

## Alternatives

- **Reuse `expandCollectionBlockFields()`.** It already returns what the admin needs. It also returns the whole `BlockType`, including fingerprints, IDs and timestamps, and throws for a missing type. Catching that error per field would leave the plugin with no block types at all for the field. Mapping a smaller public shape keeps core internals out of the plugin contract.
- **A separate `ctx.schema.listBlockTypes()`.** This avoids repeating a type under every field, and a plugin that needs one block type loads one. It leaves the plugin to join slugs to types itself and adds a second call and a second cache. Putting the types on the field matches the admin schema API and MCP, which plugin authors may already know.
- **A top-level `blockTypes` map on the collection or schema result, with fields holding slugs.** It removes the repeated payload. It changes the meaning of a `blocks` field depending on where it was read, and makes `getCollection()` return data about other collections' types. Worth reconsidering if payload size matters in practice.
- **Do nothing and keep the three workarounds.** They stay broken for queue consumers and for block types created after a seed, which is the reason for this proposal.

## Drawbacks

- A larger public plugin contract that core must keep compatible.
- Larger `listCollections()` results on sites with many block types and `blocks` fields, repeated across the sandbox bridge.
- A plugin author must handle an omitted type and an `unsupportedTypes` version, which is more work than assuming the data is complete.

## Prototype

The prototype is on the author's fork: [`feat/plugin-schema-block-types`](https://github.com/diogoascarneiro/emdash/tree/feat/plugin-schema-block-types). It is not an implementation pull request and is not meant for upstream merge before this design is accepted. It shows the shape, the query behavior, and the tests described under Verification.

## Open questions

- **Payload size.** Each `blocks` field repeats every block type it allows. The prototype measures about 23.8 KB for `listCollections()` with three collections, each allowing 20 types of four fields. Options:
  - *Keep it (prototype).* Simple, and each field reads on its own. Cost grows with the number of `blocks` fields.
  - *Deduplicate at collection level.* Put `blockTypes` once on the collection, and have each field list slugs. Smaller payload, but a plugin must join slugs to types, and `getCollection()` changes shape.
  - *Deduplicate at schema level.* One map for all collections. Smallest, but the most joining work.
  Proposed: keep it until a real site shows the cost matters. Do you want a size budget on the sandbox bridge?
- **Unsupported versions.** A version has field types this EmDash build doesn't know. That happens after a rollback or when a newer build wrote the version. The prototype returns the version with `fields: []` and `unsupportedTypes` (type and path). Alternative: omit the version. Omitting makes it look like a missing type, so a plugin can't tell that the data exists but is unreadable. Proposed: keep it, because the plugin can log it and skip safely either way.

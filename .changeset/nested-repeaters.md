---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds nested repeaters: a `repeater` field, or a repeater inside a block type, can now have sub-fields of type `repeater`, up to two levels deep. For example, pricing categories can hold products, and each product can hold its rates.

A nested repeater sets `subFields`, `minItems`, and `maxItems` directly on the sub-field:

```ts
{ slug: "rates", label: "Rates", type: "repeater", maxItems: 10, subFields: [{ slug: "price", label: "Price", type: "string" }] }
```

Define nested repeaters in the field editor, in seed files, through the schema API, or with the MCP `schema_create_field` tool, which now also accepts the `repeater` type. The admin content editor edits nested rows in collection repeaters and in blocks. In the admin, the field editor can add a repeater as a sub-field of a collection repeater field, with its own sub-fields and item limits, two levels deep. Block types have no admin editor, so define their nested repeaters in seed files, through the schema API or with MCP.

Nested image, URL, and datetime sub-fields get the same media normalization, media usage tracking, URL safety checks, and validation as top-level ones. Changing an existing collection repeater sub-field between `repeater` and a single-value type is rejected with `FIELD_TYPE_CHANGE_REQUIRES_MIGRATION`.

Upgrade every runtime and the admin before you define a nested repeater. Older runtimes treat a field or block type with one as unsupported and refuse writes to it.

---
"@emdash-cms/blocks": minor
"@emdash-cms/admin": minor
---

Adds nested repeaters to plugin Portable Text block fields. A `repeater` sub-field can now be another `repeater`, one level deep, so each row can hold its own list, such as FAQ groups that each contain questions:

```ts
elements.repeater("groups", "Groups", [
	elements.textInput("title", "Title"),
	elements.repeater("questions", "Questions", [elements.textInput("question", "Question")]),
]);
```

The block stores each nested list as an array in its row. `validateBlocks` rejects a repeater nested two levels deep.

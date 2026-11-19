---
"@emdash-cms/blocks": minor
"@emdash-cms/admin": minor
---

Adds nested repeaters to plugin Portable Text block fields. A `repeater` sub-field can now be another `repeater`, up to two levels deep, so each row can hold its own list, such as rate card categories that hold products that each hold rates:

```ts
elements.repeater("categories", "Categories", [
	elements.textInput("label", "Category"),
	elements.repeater("products", "Products", [
		elements.textInput("name", "Product name"),
		elements.repeater("rates", "Rates", [elements.textInput("price", "Price")]),
	]),
]);
```

The block stores each nested list as an array in its row. `validateBlocks` rejects a repeater nested three levels deep.

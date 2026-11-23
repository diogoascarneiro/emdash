import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { BlocksField } from "../../src/components/BlocksField.js";
import type { BlockType } from "../../src/lib/api/schema.js";
import type { StoredBlockValue } from "../../src/lib/block-field-state.js";
import { render } from "../utils/render.js";

const pricing: BlockType = {
	id: "pricing-type",
	slug: "pricing",
	label: "Pricing",
	currentVersion: 1,
	source: "seed",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	versions: [
		{
			id: "pricing-v1",
			blockTypeId: "pricing-type",
			version: 1,
			fingerprint: "pricing",
			active: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			fields: [
				{
					slug: "categories",
					label: "Categories",
					type: "repeater",
					validation: {
						subFields: [
							{ slug: "label", label: "Category", type: "string" },
							{
								slug: "products",
								label: "Products",
								type: "repeater",
								subFields: [
									{ slug: "name", label: "Product", type: "string", required: true },
									{ slug: "price", label: "Price", type: "string" },
								],
							},
						],
					},
				},
			],
		},
	],
};

const block = (categories: unknown[]): StoredBlockValue => ({
	_type: "pricing",
	_version: 1,
	_key: "pricing-1",
	categories,
});

const storage = {
	label: "Storage",
	products: [
		{ name: "R2", price: "$0.015" },
		{ name: "KV", price: "$0.50" },
	],
};

function Harness({
	initial,
	onValue,
}: {
	initial: StoredBlockValue[];
	onValue: (value: StoredBlockValue[]) => void;
}) {
	const [value, setValue] = React.useState(initial);
	return (
		<BlocksField
			id="field-layout"
			fieldPath="layout"
			label="Layout"
			value={value}
			onChange={(next) => {
				setValue(next);
				onValue(next);
			}}
			blockTypes={[pricing]}
			allowedTypes={["pricing"]}
			retiredTypes={[]}
			renderField={({ name, value: fieldValue, onChange, chrome }) => (
				<input
					id={`field-${name}`}
					aria-labelledby={chrome.labelledBy}
					aria-describedby={chrome.describedBy}
					aria-invalid={chrome.invalid || undefined}
					value={typeof fieldValue === "string" ? fieldValue : ""}
					onChange={(event) => onChange(event.target.value)}
				/>
			)}
		/>
	);
}

async function renderPricing(categories: unknown[]) {
	const onValue = vi.fn<(value: StoredBlockValue[]) => void>();
	await render(<Harness initial={[block(categories)]} onValue={onValue} />, { wrapper: Toasty });
	await page.getByRole("button", { name: "Pricing", exact: true }).click();
	return () => onValue.mock.lastCall?.[0][0]?.categories;
}

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function pointer(type: string, x: number, y: number) {
	return new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		isPrimary: true,
		pointerId: 1,
		button: 0,
		buttons: type === "pointerup" ? 0 : 1,
		clientX: x,
		clientY: y,
	});
}

describe("A list inside a block's list item", () => {
	it("edits a value two lists down and saves only that value", async () => {
		const latest = await renderPricing([storage]);
		await page.getByRole("button", { name: "Storage", exact: true }).click();

		const price = page.getByRole("textbox", { name: "Price 2", exact: true });
		await price.fill("$0.45");

		expect(latest()).toEqual([
			{
				label: "Storage",
				products: [
					{ name: "R2", price: "$0.015" },
					{ name: "KV", price: "$0.45" },
				],
			},
		]);
	});

	it("starts a new item with an empty nested list, and adds rows to it", async () => {
		const latest = await renderPricing([storage]);
		await page.getByRole("button", { name: "Add item to Categories" }).click();
		await userEvent.keyboard("Compute");

		expect(latest()).toEqual([storage, { label: "Compute", products: [] }]);

		await page.getByRole("button", { name: "Add item to Products" }).last().click();
		await userEvent.keyboard("Workers");
		expect(latest()).toEqual([storage, { label: "Compute", products: [{ name: "Workers" }] }]);
	});

	it("reorders a nested list's rows by drag, leaving the outer list as it was", async () => {
		const latest = await renderPricing([storage, { label: "Compute", products: [] }]);
		await page.getByRole("button", { name: "Storage", exact: true }).click();

		const products = page.getByRole("table").element();
		const rows = [...products.querySelectorAll<HTMLElement>("[data-list-item]")];
		const handle = rows[0]!.querySelector<HTMLElement>(".cursor-grab")!;
		const start = rows[0]!.getBoundingClientRect();
		const target = rows[1]!.getBoundingClientRect();
		const x = start.left + 4;
		const y = start.top + start.height / 2;
		const end = target.top + target.height / 2 + 12;
		handle.dispatchEvent(pointer("pointerdown", x, y));
		for (let step = 1; step <= 12; step++) {
			document.dispatchEvent(pointer("pointermove", x, y + ((end - y) * step) / 12));
			await frame();
		}
		document.dispatchEvent(pointer("pointerup", x, end));

		await expect.poll(latest).toEqual([
			{
				label: "Storage",
				products: [
					{ name: "KV", price: "$0.50" },
					{ name: "R2", price: "$0.015" },
				],
			},
			{ label: "Compute", products: [] },
		]);
	});

	it("calls off an Undo for a nested item once its parent list is reordered", async () => {
		const latest = await renderPricing([
			{ label: "Storage", products: [{ name: "R2" }, { name: "KV" }] },
			{ label: "Compute", products: [{ name: "Workers" }] },
		]);
		await page.getByRole("button", { name: "Storage", exact: true }).click();
		await page.getByRole("button", { name: "R2 actions" }).click();
		await page.getByRole("menuitem", { name: "Delete" }).click();
		await expect.element(page.getByRole("button", { name: "Undo" })).toBeVisible();

		(page.getByRole("button", { name: "Storage", exact: true }).element() as HTMLElement).focus();
		await userEvent.keyboard("{Alt>}{Shift>}{ArrowDown}{/Shift}{/Alt}");

		await expect.poll(() => (latest() as Array<{ label: string }>)[0]?.label).toBe("Compute");
		// The toast would also expire by itself, so only a prompt dismissal counts.
		await expect
			.poll(() => page.getByRole("button", { name: "Undo" }).all().length, { timeout: 1000 })
			.toBe(0);
	});
});

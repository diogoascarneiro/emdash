import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../dist/styles.css";

import {
	PortableTextEditor,
	type PortableTextEditorProps,
} from "../../src/components/PortableTextEditor.js";
import { render } from "../utils/render.js";

vi.mock("../../src/lib/api/current-user.js", () => ({
	useCurrentUser: () => ({ data: { id: "editor-1", role: 40 } }),
}));

const pluginBlocks: NonNullable<PortableTextEditorProps["pluginBlocks"]> = [
	{
		type: "test.cases",
		pluginId: "test-cases",
		label: "Cases",
		fields: [
			{
				type: "repeater",
				action_id: "cases",
				label: "Cases",
				item_label: "case",
				fields: [
					{ type: "text_input", action_id: "title", label: "Title" },
					{
						type: "repeater",
						action_id: "rows",
						label: "Rows",
						item_label: "row",
						fields: [{ type: "text_input", action_id: "label", label: "Label" }],
					},
				],
			},
		],
	},
];

describe("plugin block nested repeater", () => {
	it("saves rows inside each item and keeps them through reload and edit", async () => {
		const onChange = vi.fn<NonNullable<PortableTextEditorProps["onChange"]>>();
		function Editor() {
			const [value, setValue] = React.useState<NonNullable<PortableTextEditorProps["value"]>>([
				{ _type: "test.cases", _key: "cases-1", cases: [] },
			]);
			const [generation, setGeneration] = React.useState(0);
			return (
				<>
					<PortableTextEditor
						key={generation}
						value={value}
						pluginBlocks={pluginBlocks}
						onChange={(next) => {
							setValue(next);
							onChange(next);
						}}
					/>
					<button onClick={() => setGeneration((previous) => previous + 1)}>Reload editor</button>
				</>
			);
		}
		const screen = await render(<Editor />);
		const openBlock = () => screen.getByRole("button", { name: "Edit", exact: true }).click();
		const saveBlock = () => screen.getByRole("button", { name: "Save", exact: true }).click();
		const expectCases = async (cases: unknown[]) => {
			await vi.waitFor(() => {
				expect(onChange.mock.lastCall?.[0]).toEqual([
					expect.objectContaining({ _type: "test.cases", cases }),
				]);
			});
		};

		await openBlock();
		await screen.getByRole("button", { name: "Add case", exact: true }).first().click();
		await screen.getByRole("textbox", { name: "Title", exact: true }).fill("Alpha");
		await screen.getByRole("button", { name: "Add row", exact: true }).first().click();
		await screen.getByRole("textbox", { name: "Label", exact: true }).fill("x");
		await screen.getByRole("button", { name: "Add row", exact: true }).first().click();
		await screen.getByRole("textbox", { name: "Label", exact: true }).last().fill("y");
		await screen.getByRole("button", { name: "Alpha", exact: true }).click();
		await screen.getByRole("button", { name: "Add case", exact: true }).click();
		await screen.getByRole("textbox", { name: "Title", exact: true }).fill("Beta");
		await saveBlock();
		await expectCases([
			{ title: "Alpha", rows: [{ label: "x" }, { label: "y" }] },
			{ title: "Beta", rows: [] },
		]);

		await screen.getByRole("button", { name: "Reload editor", exact: true }).click();
		await openBlock();
		await screen.getByRole("button", { name: "Alpha", exact: true }).click();
		await screen.getByRole("button", { name: "y", exact: true }).click();
		await screen.getByRole("textbox", { name: "Label", exact: true }).fill("z");
		await saveBlock();
		await expectCases([
			{ title: "Alpha", rows: [{ label: "x" }, { label: "z" }] },
			{ title: "Beta", rows: [] },
		]);

		await openBlock();
		await screen.getByRole("button", { name: "Alpha", exact: true }).click();
		const handles = screen.getByRole("button", { name: "Drag to reorder" });
		// Handles in document order: Alpha, its rows x and z, then Beta.
		await userEvent.dragAndDrop(handles.nth(1), handles.nth(2));
		await saveBlock();
		await expectCases([
			{ title: "Alpha", rows: [{ label: "z" }, { label: "x" }] },
			{ title: "Beta", rows: [] },
		]);
	});
});

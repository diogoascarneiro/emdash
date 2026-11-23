import { describe, expect, it } from "vitest";

import { buildContentMediaUsageFieldFingerprint } from "../../../src/media/usage/content-fields.js";
import {
	buildCanonicalSha256Fingerprint,
	buildMediaUsageProjectionFingerprint,
} from "../../../src/media/usage/projection-fingerprint.js";
import { CONTENT_SOURCE_SCHEMA_VERSION } from "../../../src/media/usage/types.js";

const source = {
	sourceKey: "content:posts:entry-1:columns",
	sourceType: "content",
	collectionSlug: "posts",
	contentId: "entry-1",
	sourceVariant: "columns" as const,
	locale: "en",
	translationGroup: "translation-1",
	contentSlug: "entry-1",
	contentTitle: "Entry 1",
	contentStatus: "published",
	contentScheduledAt: null,
	contentDeletedAt: null,
	revisionId: null,
	schemaVersion: 1,
};
const occurrences = [
	{
		fieldSlug: "gallery",
		fieldPath: "gallery[1]",
		occurrenceIndex: 1,
		referenceType: "image_field" as const,
		mediaId: "media-2",
		provider: "local",
		providerAssetId: "media-2",
		mediaKind: "image" as const,
		mimeType: "image/webp",
	},
	{
		fieldSlug: "gallery",
		fieldPath: "gallery[0]",
		occurrenceIndex: 0,
		referenceType: "image_field" as const,
		mediaId: "media-1",
		provider: "local",
		providerAssetId: "media-1",
		mediaKind: "image" as const,
		mimeType: "image/webp",
	},
];
const extractionFields = [{ slug: "gallery", type: "image" as const }];

it("is order-independent but changes for every projection input class", async () => {
	const baseline = await fingerprint();
	expect((await fingerprint({ occurrences: occurrences.toReversed() })).fingerprint).toBe(
		baseline.fingerprint,
	);
	expect((await fingerprint({ collectionId: "collection-2" })).fingerprint).not.toBe(
		baseline.fingerprint,
	);
	expect(
		(await fingerprint({ source: { ...source, contentTitle: "Changed title" } })).fingerprint,
	).not.toBe(baseline.fingerprint);
	expect(
		(
			await fingerprint({
				occurrences: [{ ...occurrences[0]!, mediaId: "changed-media" }, occurrences[1]!],
			})
		).fingerprint,
	).not.toBe(baseline.fingerprint);
	expect(
		(
			await fingerprint({
				extractionFields: [...extractionFields, { slug: "hero", type: "image" as const }],
			})
		).fingerprint,
	).not.toBe(baseline.fingerprint);
	expect(baseline.fingerprint).toMatch(/^media-usage-projection:v1:sha256:[a-f0-9]{64}$/);
	expect(baseline.byteLength).toBeGreaterThan(0);
});

describe("nested repeater sub-fields", () => {
	const nested = (subFields: { slug: string; type: "image" }[]) => ({
		slug: "sections",
		type: "repeater" as const,
		validation: {
			subFields: [
				{ slug: "photo", type: "image" as const },
				{ slug: "items", type: "repeater" as const, subFields },
			],
		},
	});
	const flat = {
		slug: "sections",
		type: "repeater" as const,
		validation: { subFields: [{ slug: "photo", type: "image" as const }] },
	};

	it("changes the projection fingerprint when a nested sub-field changes", async () => {
		const [a, b, c] = await Promise.all([
			fingerprint({ extractionFields: [nested([{ slug: "icon", type: "image" }])] }),
			fingerprint({ extractionFields: [nested([{ slug: "logo", type: "image" }])] }),
			fingerprint({ extractionFields: [flat] }),
		]);
		expect(a.fingerprint).not.toBe(b.fingerprint);
		expect(a.fingerprint).not.toBe(c.fingerprint);
	});

	it("keeps the content field fingerprint of a flat repeater what it was before nesting", async () => {
		const legacy = await buildCanonicalSha256Fingerprint("media-usage-fields:v1:sha256:", {
			fingerprintVersion: 1,
			contentSourceSchemaVersion: CONTENT_SOURCE_SCHEMA_VERSION,
			extractionFields: [
				{ slug: "sections", type: "repeater", subFields: [{ slug: "photo", type: "image" }] },
			],
			displayFieldSlugs: [],
		});
		expect(
			await buildContentMediaUsageFieldFingerprint({
				extractionFields: [flat],
				displayFieldSlugs: [],
			}),
		).toBe(legacy.fingerprint);
		expect(
			await buildContentMediaUsageFieldFingerprint({
				extractionFields: [nested([{ slug: "icon", type: "image" }])],
				displayFieldSlugs: [],
			}),
		).not.toBe(legacy.fingerprint);
	});
});

it("returns the reused UTF-8 payload length with the fingerprint", async () => {
	const ascii = await fingerprint({ source: { ...source, contentTitle: "e" } });
	const multibyte = await fingerprint({ source: { ...source, contentTitle: "é" } });

	expect(multibyte.byteLength).toBe(ascii.byteLength + 1);
});

it("refuses to mint a current fingerprint without immutable collection identity", async () => {
	await expect(fingerprint({ collectionId: "" })).rejects.toThrow(/collection identity/i);
});

function fingerprint(
	overrides: Partial<Parameters<typeof buildMediaUsageProjectionFingerprint>[0]> = {},
) {
	return buildMediaUsageProjectionFingerprint({
		collectionId: "collection-1",
		source,
		occurrences,
		extractionFields,
		...overrides,
	});
}

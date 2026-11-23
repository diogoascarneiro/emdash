import type { FieldValidation, RepeaterSubField } from "./types.js";
import { REPEATER_SUB_FIELD_TYPES } from "./types.js";

/** How many repeaters can enclose a repeater sub-field: the field's own, and one nested list. */
export const MAX_REPEATER_NESTING = 2;

export const REPEATER_NESTING_MESSAGE = `Repeaters can be nested only ${MAX_REPEATER_NESTING} levels deep`;

const SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_SLUG_LENGTH = 63;
const MAX_LABEL_LENGTH = 200;
const RESERVED_VALUE_KEYS: ReadonlySet<string> = new Set(["_type", "_version", "_key"]);
const SCALAR_TYPES: ReadonlySet<string> = new Set(REPEATER_SUB_FIELD_TYPES);
const NESTED_REPEATER_KEYS: ReadonlySet<string> = new Set([
	"slug",
	"type",
	"label",
	"required",
	"subFields",
	"minItems",
	"maxItems",
]);

export interface RepeaterSubFieldIssue {
	path: string;
	message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): boolean {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): boolean {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function optionIssue(options: unknown): string | undefined {
	if (!Array.isArray(options) || options.length === 0) return "must be a non-empty array";
	if (options.some((option) => typeof option !== "string" || option.length === 0)) {
		return "must contain non-empty strings";
	}
	if (new Set(options).size !== options.length) return "must not contain duplicates";
	return undefined;
}

/**
 * Problems in a list of repeater sub-field definitions, in order. `enclosingRepeaters`
 * counts the repeaters around the list. With `lenientScalars`, single-value sub-fields
 * directly in this list are not checked, which keeps collection fields as permissive as
 * they have always been; everything inside a nested repeater is checked in full.
 */
export function repeaterSubFieldIssues(
	value: unknown,
	path: string,
	options: { enclosingRepeaters?: number; lenientScalars?: boolean } = {},
): RepeaterSubFieldIssue[] {
	const enclosing = options.enclosingRepeaters ?? 1;
	const issues: RepeaterSubFieldIssue[] = [];
	const issue = (at: string, message: string) => issues.push({ path: at, message });
	if (!Array.isArray(value) || value.length === 0) {
		issue(path, "must be a non-empty array");
		return issues;
	}
	const slugs = new Set<string>();
	const repeaterSlugs = new Set<string>();
	for (const [index, subField] of value.entries()) {
		const at = `${path}[${index}]`;
		if (!isRecord(subField)) {
			if (!options.lenientScalars) issue(at, "must be an object");
			continue;
		}
		const isRepeater = subField.type === "repeater";
		if (options.lenientScalars && !isRepeater) {
			// Rows are keyed by slug, so a list must not share one with a sibling.
			if (typeof subField.slug === "string") {
				if (repeaterSlugs.has(subField.slug)) {
					issue(`${at}.slug`, `duplicate slug "${subField.slug}"`);
				}
				slugs.add(subField.slug);
			}
			continue;
		}

		const slug = subField.slug;
		if (
			typeof slug !== "string" ||
			slug.length === 0 ||
			slug.length > MAX_SLUG_LENGTH ||
			!SLUG_PATTERN.test(slug)
		) {
			issue(
				`${at}.slug`,
				"must start with a letter and contain only lowercase letters, numbers, and underscores",
			);
		} else if (RESERVED_VALUE_KEYS.has(slug)) {
			issue(`${at}.slug`, `"${slug}" is reserved`);
		} else if (slugs.has(slug)) {
			issue(`${at}.slug`, `duplicate slug "${slug}"`);
		} else {
			slugs.add(slug);
			if (isRepeater) repeaterSlugs.add(slug);
		}
		const label = subField.label;
		if (typeof label !== "string" || label.trim().length === 0 || label.length > MAX_LABEL_LENGTH) {
			issue(`${at}.label`, `must contain between 1 and ${MAX_LABEL_LENGTH} characters`);
		}
		if (subField.required !== undefined && typeof subField.required !== "boolean") {
			issue(`${at}.required`, "must be a boolean");
		}

		if (isRepeater) {
			if (enclosing > MAX_REPEATER_NESTING) {
				issue(`${at}.type`, REPEATER_NESTING_MESSAGE);
				continue;
			}
			for (const key of Object.keys(subField)) {
				if (!NESTED_REPEATER_KEYS.has(key)) {
					issue(`${at}.${key}`, `is not supported for type "repeater"`);
				}
			}
			if (subField.minItems !== undefined && !isNonNegativeInteger(subField.minItems)) {
				issue(`${at}.minItems`, "must be a non-negative integer");
			}
			if (subField.maxItems !== undefined && !isPositiveInteger(subField.maxItems)) {
				issue(`${at}.maxItems`, "must be a positive integer");
			}
			if (
				typeof subField.minItems === "number" &&
				typeof subField.maxItems === "number" &&
				subField.minItems > subField.maxItems
			) {
				issue(`${at}.maxItems`, "must be greater than or equal to minItems");
			}
			issues.push(
				...repeaterSubFieldIssues(subField.subFields, `${at}.subFields`, {
					enclosingRepeaters: enclosing + 1,
				}),
			);
			continue;
		}

		const type = subField.type;
		if (typeof type !== "string" || !SCALAR_TYPES.has(type)) {
			issue(`${at}.type`, `unsupported repeater field type "${String(type)}"`);
			continue;
		}
		if (type === "select") {
			const problem = optionIssue(subField.options);
			if (problem) issue(`${at}.options`, problem);
		} else if (subField.options !== undefined) {
			issue(`${at}.options`, `is not supported for type "${type}"`);
		}
	}
	return issues;
}

/**
 * The first sub-field type this runtime cannot read, including a repeater nested
 * deeper than {@link MAX_REPEATER_NESTING}. Stored definitions are unvalidated JSON.
 */
export function findUnsupportedRepeaterSubFieldType(
	subFields: unknown,
	path: string,
	enclosingRepeaters = 1,
): { type: string; path: string } | undefined {
	if (!Array.isArray(subFields)) return undefined;
	for (const [index, subField] of subFields.entries()) {
		if (!isRecord(subField) || typeof subField.type !== "string") continue;
		const at = `${path}[${index}]`;
		if (subField.type === "repeater") {
			if (enclosingRepeaters > MAX_REPEATER_NESTING) {
				return { type: subField.type, path: `${at}.type` };
			}
			const nested = findUnsupportedRepeaterSubFieldType(
				subField.subFields,
				`${at}.subFields`,
				enclosingRepeaters + 1,
			);
			if (nested) return nested;
		} else if (!SCALAR_TYPES.has(subField.type)) {
			return { type: subField.type, path: `${at}.type` };
		}
	}
	return undefined;
}

/** A sub-field as the field definition its values are validated against. */
export function repeaterSubFieldAsField(subField: RepeaterSubField): {
	type: RepeaterSubField["type"];
	required: boolean;
	validation?: FieldValidation;
} {
	if (subField.type === "repeater") {
		return {
			type: "repeater",
			required: subField.required ?? false,
			validation: {
				subFields: subField.subFields,
				...(subField.minItems !== undefined ? { minItems: subField.minItems } : {}),
				...(subField.maxItems !== undefined ? { maxItems: subField.maxItems } : {}),
			},
		};
	}
	return {
		type: subField.type,
		required: subField.required ?? false,
		...(subField.options ? { validation: { options: subField.options } } : {}),
	};
}

/**
 * Dotted paths to every sub-field of `type`, through nested repeaters: `link` for a
 * sub-field of the field's rows, `products.rates.link` for one two lists down. Slugs
 * cannot contain dots, so a path is unambiguous. Reads unvalidated JSON.
 */
export function repeaterSubFieldPaths(
	subFields: unknown,
	type: string,
	enclosingRepeaters = 1,
): string[] {
	if (!Array.isArray(subFields)) return [];
	return subFields.flatMap((subField): string[] => {
		if (!isRecord(subField) || typeof subField.slug !== "string") return [];
		const slug = subField.slug;
		if (subField.type === type) return [slug];
		if (subField.type !== "repeater" || enclosingRepeaters > MAX_REPEATER_NESTING) return [];
		return repeaterSubFieldPaths(subField.subFields, type, enclosingRepeaters + 1).map(
			(nested) => `${slug}.${nested}`,
		);
	});
}

/** Location of one value inside a repeater: row indexes and slugs, outermost first. */
export type RepeaterValueLocation = ReadonlyArray<number | string>;

/**
 * Visits each value at `path` (from {@link repeaterSubFieldPaths}) in `rows`. Rows that
 * are not objects and nested values that are not arrays are skipped.
 */
export function visitRepeaterValues(
	rows: unknown,
	path: string,
	visit: (row: Record<string, unknown>, slug: string, location: RepeaterValueLocation) => void,
	location: RepeaterValueLocation = [],
): void {
	if (!Array.isArray(rows)) return;
	const dot = path.indexOf(".");
	const slug = dot === -1 ? path : path.slice(0, dot);
	for (const [index, row] of rows.entries()) {
		if (!isRecord(row)) continue;
		if (dot === -1) visit(row, slug, [...location, index, slug]);
		else visitRepeaterValues(row[slug], path.slice(dot + 1), visit, [...location, index, slug]);
	}
}

/**
 * Copy-on-write map over each value at `path` in `rows`. Returns `rows` itself when
 * `map` changes nothing, so callers can tell whether anything changed.
 */
export function mapRepeaterValues(
	rows: unknown[],
	path: string,
	map: (value: unknown, location: RepeaterValueLocation) => unknown,
	location: RepeaterValueLocation = [],
): unknown[] {
	const dot = path.indexOf(".");
	const slug = dot === -1 ? path : path.slice(0, dot);
	let result = rows;
	for (const [index, row] of rows.entries()) {
		if (!isRecord(row)) continue;
		const current = row[slug];
		const rowLocation = [...location, index, slug];
		let next: unknown;
		if (dot === -1) next = map(current, rowLocation);
		else if (Array.isArray(current))
			next = mapRepeaterValues(current, path.slice(dot + 1), map, rowLocation);
		else continue;
		if (Object.is(next, current)) continue;
		if (result === rows) result = [...rows];
		result[index] = { ...row, [slug]: next };
	}
	return result;
}

/** Formats a location the way content validation reports paths: `field.0.sub.1.leaf`. */
export function dottedRepeaterLocation(fieldSlug: string, location: RepeaterValueLocation): string {
	return [fieldSlug, ...location].join(".");
}

/**
 * Sub-fields whose type changes between a single value and a list of rows, through
 * nested repeaters. Stored rows hold the old shape, which the new definition cannot read.
 */
export function repeaterListTypeChanges(
	before: unknown,
	after: unknown,
	path = "validation.subFields",
): string[] {
	if (!Array.isArray(before) || !Array.isArray(after)) return [];
	const previous = new Map<string, Record<string, unknown>>();
	for (const subField of before) {
		if (isRecord(subField) && typeof subField.slug === "string") {
			previous.set(subField.slug, subField);
		}
	}
	return after.flatMap((subField): string[] => {
		if (!isRecord(subField) || typeof subField.slug !== "string") return [];
		const old = previous.get(subField.slug);
		if (!old) return [];
		const at = `${path}.${subField.slug}`;
		const wasList = old.type === "repeater";
		const isList = subField.type === "repeater";
		if (wasList !== isList) return [at];
		return isList
			? repeaterListTypeChanges(old.subFields, subField.subFields, `${at}.subFields`)
			: [];
	});
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  validateAgentJsonSchemaInstance,
} from "../skills/npc-moneyhand/scripts/lib/agent-descriptor.mjs";
import { DEFAULT_PAGE_WAIT_UNTIL } from "../skills/npc-moneyhand/scripts/lib/page-transitions.mjs";
import { describeMoneyHand } from "../skills/npc-moneyhand/scripts/moneyhand.mjs";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const CATALOG_PATH = "skills/npc-moneyhand/references/agent-operations.json";
const CONTRACT_PATH = "skills/npc-moneyhand/references/moneyhand-contract.json";

function resolvePointer(root, pointer) {
  assert.match(pointer, /^#\//u);
  return pointer.slice(2).split("/").reduce((value, encoded) => {
    const key = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    assert.ok(value && typeof value === "object" && Object.hasOwn(value, key));
    return value[key];
  }, root);
}

function mergeObjects(left, right) {
  if (!left || typeof left !== "object" || Array.isArray(left)
    || !right || typeof right !== "object" || Array.isArray(right)) return right;
  return { ...left, ...right };
}

function minimalInstance(schemaValue, root) {
  if (schemaValue === true) return null;
  assert.notEqual(schemaValue, false);
  assert.ok(schemaValue && typeof schemaValue === "object" && !Array.isArray(schemaValue));
  const schema = schemaValue.$ref === undefined
    ? schemaValue
    : { ...resolvePointer(root, schemaValue.$ref), ...schemaValue, $ref: undefined };
  if (schema.const !== undefined) return structuredClone(schema.const);
  if (Array.isArray(schema.enum)) return structuredClone(schema.enum[0]);
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.reduce(
      (value, branch) => mergeObjects(value, minimalInstance(branch, root)),
      {},
    );
  }
  if (Array.isArray(schema.oneOf)) {
    const selected = schema.oneOf[0];
    const branch = minimalInstance(selected, root);
    if (schema.type !== "object") return branch;
    const base = minimalInstance({ ...schema, oneOf: undefined }, root);
    for (const field of selected.required ?? []) {
      if (!Object.hasOwn(base, field)) {
        base[field] = minimalInstance(schema.properties?.[field] ?? {}, root);
      }
      if (selected.properties?.[field] === undefined) delete branch[field];
    }
    return mergeObjects(base, branch);
  }
  if (Array.isArray(schema.anyOf)) {
    const selected = schema.anyOf.find((branch) => branch.properties !== undefined)
      ?? schema.anyOf[0];
    const branch = minimalInstance(selected, root);
    if (schema.type !== "object") return branch;
    const base = minimalInstance({ ...schema, anyOf: undefined }, root);
    for (const field of selected.required ?? []) {
      if (!Object.hasOwn(base, field)) {
        base[field] = minimalInstance(schema.properties?.[field] ?? {}, root);
      }
      if (selected.properties?.[field] === undefined) delete branch[field];
    }
    return mergeObjects(base, branch);
  }
  const type = Array.isArray(schema.type)
    ? schema.type[0]
    : schema.type ?? (schema.properties !== undefined || schema.required !== undefined
      ? "object"
      : undefined);
  if (type === "object") {
    const output = {};
    for (const field of schema.required ?? []) {
      output[field] = minimalInstance(schema.properties?.[field] ?? {}, root);
    }
    return output;
  }
  if (type === "array") {
    return Array.from(
      { length: schema.minItems ?? 0 },
      () => minimalInstance(schema.items ?? {}, root),
    );
  }
  if (type === "string") {
    if (schema.format === "date-time") return "2026-08-08T00:00:00.000Z";
    if (schema.pattern === "^[a-f0-9]{64}$") return "a".repeat(64);
    return "x".repeat(Math.max(1, schema.minLength ?? 1));
  }
  if (type === "integer" || type === "number") return Math.max(0, schema.minimum ?? 0);
  if (type === "boolean") return false;
  if (type === "null") return null;
  return null;
}

function resultValueSchema(operation) {
  return operation.resultSchema.oneOf[0].allOf[1].properties.value;
}

test("every MoneyHand Agent operation validates offline without dispatching browser effects", async () => {
  const [descriptor, catalog, contract] = await Promise.all([
    describeMoneyHand(),
    readFile(resolve(CATALOG_PATH), "utf8").then(JSON.parse),
    readFile(resolve(CONTRACT_PATH), "utf8").then(JSON.parse),
  ]);
  assert.equal(catalog.jsonSchemaDialect, DIALECT);
  assert.deepEqual(descriptor.operationCatalog, catalog);
  assert.deepEqual(descriptor.contract, contract);
  assert.equal(Object.keys(contract.operationContracts).length, catalog.operations.length);
  assert.ok(catalog.operations.length > 0);
  for (const [index, operation] of catalog.operations.entries()) {
    assert.deepEqual(resolvePointer(catalog, operation.schemaPointers.args), operation.argsSchema);
    assert.deepEqual(resolvePointer(catalog, operation.schemaPointers.result), operation.resultSchema);
    const operationContract = resolvePointer(contract, operation.contractRef);
    assert.equal(operationContract.operation, operation.op);
    assert.equal(
      operationContract.argsSchemaRef,
      `references/agent-operations.json${operation.schemaPointers.args}`,
    );
    assert.equal(
      operationContract.resultSchemaRef,
      `references/agent-operations.json${operation.schemaPointers.result}`,
    );
    assert.equal(
      validateAgentJsonSchemaInstance(
        operation.argsSchema,
        operation.examples.validArgs,
        catalog,
      ).valid,
      true,
      `${operation.op} validArgs`,
    );
    assert.equal(
      validateAgentJsonSchemaInstance(
        operation.argsSchema,
        operation.examples.invalidArgs,
        catalog,
      ).valid,
      false,
      `${operation.op} invalidArgs`,
    );
    const valueSchema = resultValueSchema(operation);
    const value = minimalInstance(valueSchema, catalog);
    const success = { type: "result", id: `schema-${index}`, ok: true, value };
    const failure = {
      type: "result",
      id: `schema-${index}`,
      ok: false,
      error: { code: "SCHEMA_TEST", message: "offline schema probe" },
    };
    assert.equal(
      validateAgentJsonSchemaInstance(operation.resultSchema, success, catalog).valid,
      true,
    );
    assert.equal(
      validateAgentJsonSchemaInstance(operation.resultSchema, failure, catalog).valid,
      true,
    );
    assert.equal(validateAgentJsonSchemaInstance(operation.resultSchema, {
      type: "result",
      id: `schema-${index}`,
      ok: true,
    }, catalog).valid, false);
  }
});

test("page transition machine contracts advertise the runtime readiness default", async () => {
  const descriptor = await describeMoneyHand();
  assert.equal(
    descriptor.capabilities.pageTransitions.defaultWaitUntil,
    DEFAULT_PAGE_WAIT_UNTIL,
  );
  assert.equal(
    descriptor.contract.pageTransitions.defaultWaitUntil,
    DEFAULT_PAGE_WAIT_UNTIL,
  );
  for (const operationName of ["waitForTaskPage", "navigateTaskTab"]) {
    const operation = descriptor.operationCatalog.operations
      .find((entry) => entry.op === operationName);
    assert.equal(operation.argsSchema.properties.waitUntil.default, DEFAULT_PAGE_WAIT_UNTIL);
  }
});

test("MoneyHand semantic action schemas match runtime pre-dispatch guards", async () => {
  const descriptor = await describeMoneyHand();
  const semanticRef = descriptor.operationCatalog.operations
    .find((operation) => operation.op === "actSemanticRef").argsSchema;
  const semanticLocator = descriptor.operationCatalog.operations
    .find((operation) => operation.op === "actSemanticLocator").argsSchema;
  const refBase = {
    taskSpaceId: "task-1",
    snapshotId: "snapshot-1",
    ref: "ref-1",
    action: "click",
    effect: "input",
  };
  assert.equal(
    validateAgentJsonSchemaInstance(semanticRef, refBase, descriptor.operationCatalog).valid,
    true,
  );
  assert.equal(validateAgentJsonSchemaInstance(semanticRef, {
    ...refBase,
    effect: "read-only",
  }, descriptor.operationCatalog).valid, false);
  const locatorBase = {
    taskSpaceId: "task-1",
    tabId: 1,
    locator: { kind: "role", role: "button", name: "Save" },
    action: "click",
    effect: "input",
  };
  for (const invalid of [
    { ...locatorBase, effect: "focus" },
    { ...locatorBase, state: "attached" },
    { ...locatorBase, action: "upload" },
  ]) {
    assert.equal(
      validateAgentJsonSchemaInstance(
        semanticLocator,
        invalid,
        descriptor.operationCatalog,
      ).valid,
      false,
    );
  }
});

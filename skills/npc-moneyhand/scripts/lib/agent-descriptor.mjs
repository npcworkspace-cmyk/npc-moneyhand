import { readFile } from "node:fs/promises";
import hostProcess from "node:process";

export const AGENT_CLI_DESCRIPTOR_SCHEMA = "npc-agent-cli-descriptor/1";
export const AGENT_OPERATION_CATALOG_SCHEMA = "npc-agent-operation-catalog/1";
export const AGENT_JSONL_ARGUMENTS_FIELD = "args";
const AGENT_OPERATION_EFFECTS = new Set([
  "caller-dependent",
  "external-read",
  "external-write",
  "filesystem-write",
  "local-state",
  "process-control",
  "process-lifecycle",
]);

function invalidCommand(message) {
  const error = new TypeError(message);
  error.code = "INVALID_COMMAND";
  return error;
}

export function normalizeAgentJsonlCommandEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidCommand("JSONL command must be an object");
  }
  if (!Object.hasOwn(value, AGENT_JSONL_ARGUMENTS_FIELD)) return value;
  const args = value[AGENT_JSONL_ARGUMENTS_FIELD];
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw invalidCommand("JSONL command args must be an object");
  }
  const mixedFields = Object.keys(value).filter(
    (key) => !["id", "op", AGENT_JSONL_ARGUMENTS_FIELD].includes(key),
  );
  if (mixedFields.length > 0) {
    throw invalidCommand(
      `JSONL command cannot mix args with top-level argument fields: ${mixedFields.join(", ")}`,
    );
  }
  const reservedFields = ["id", "op", AGENT_JSONL_ARGUMENTS_FIELD]
    .filter((key) => Object.hasOwn(args, key));
  if (reservedFields.length > 0) {
    throw invalidCommand(
      `JSONL command args cannot redefine reserved fields: ${reservedFields.join(", ")}`,
    );
  }
  return {
    id: value.id,
    op: value.op,
    args: { ...args },
  };
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.length < 1) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requiredStringArray(value, label) {
  if (!Array.isArray(value)
    || value.some((entry) => typeof entry !== "string" || entry.length < 1)
    || new Set(value).size !== value.length) {
    throw new TypeError(`${label} must be an array of unique non-empty strings`);
  }
  return value;
}

function resolveJsonPointer(root, pointer, label = "JSON pointer") {
  if (typeof pointer !== "string" || !pointer.startsWith("#/")) {
    throw new TypeError(`${label} must be a local JSON pointer`);
  }
  let value = root;
  for (const encoded of pointer.slice(2).split("/")) {
    const key = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) {
      throw new TypeError(`${label} does not resolve`);
    }
    value = value[key];
  }
  return value;
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function jsonTypeMatches(type, value) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

export function validateAgentJsonSchemaInstance(schemaValue, instance, rootSchema = schemaValue) {
  const errors = [];
  const validate = (schema, value, path) => {
    if (schema === true) return;
    if (schema === false) {
      errors.push(`${path} is rejected by a false schema`);
      return;
    }
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      throw new TypeError(`${path} schema must be an object or boolean`);
    }
    if (schema.$ref !== undefined) {
      const referenced = resolveJsonPointer(rootSchema, schema.$ref, `${path}.$ref`);
      validate(referenced, value, path);
    }
    if (schema.allOf !== undefined) {
      if (!Array.isArray(schema.allOf)) throw new TypeError(`${path}.allOf must be an array`);
      for (const branch of schema.allOf) validate(branch, value, path);
    }
    if (schema.anyOf !== undefined) {
      if (!Array.isArray(schema.anyOf) || schema.anyOf.length < 1) {
        throw new TypeError(`${path}.anyOf must be a non-empty array`);
      }
      const matches = schema.anyOf.filter((branch) => (
        validateAgentJsonSchemaInstance(branch, value, rootSchema).valid
      )).length;
      if (matches < 1) errors.push(`${path} does not match anyOf`);
    }
    if (schema.oneOf !== undefined) {
      if (!Array.isArray(schema.oneOf) || schema.oneOf.length < 1) {
        throw new TypeError(`${path}.oneOf must be a non-empty array`);
      }
      const matches = schema.oneOf.filter((branch) => (
        validateAgentJsonSchemaInstance(branch, value, rootSchema).valid
      )).length;
      if (matches !== 1) errors.push(`${path} must match exactly one oneOf branch`);
    }
    if (schema.const !== undefined && !sameJsonValue(value, schema.const)) {
      errors.push(`${path} does not equal const`);
    }
    if (schema.enum !== undefined) {
      if (!Array.isArray(schema.enum) || schema.enum.length < 1) {
        throw new TypeError(`${path}.enum must be a non-empty array`);
      }
      if (!schema.enum.some((candidate) => sameJsonValue(candidate, value))) {
        errors.push(`${path} is not in enum`);
      }
    }
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.every((type) => typeof type === "string") || types.length < 1) {
        throw new TypeError(`${path}.type must name one or more JSON types`);
      }
      if (!types.some((type) => jsonTypeMatches(type, value))) {
        errors.push(`${path} has the wrong type`);
        return;
      }
    }
    if (typeof value === "string") {
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(`${path} is shorter than minLength`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(`${path} is longer than maxLength`);
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
        errors.push(`${path} does not match pattern`);
      }
      if (schema.format === "date-time" && !Number.isFinite(Date.parse(value))) {
        errors.push(`${path} is not a date-time`);
      }
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`${path} is below minimum`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(`${path} is above maximum`);
      }
    }
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push(`${path} has fewer than minItems`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push(`${path} has more than maxItems`);
      }
      if (schema.uniqueItems === true
        && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) {
        errors.push(`${path} has duplicate items`);
      }
      if (schema.items !== undefined) {
        value.forEach((entry, index) => validate(schema.items, entry, `${path}[${index}]`));
      }
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const keys = Object.keys(value);
      if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
        errors.push(`${path} has fewer than minProperties`);
      }
      if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
        errors.push(`${path} has more than maxProperties`);
      }
      if (schema.required !== undefined) {
        if (!Array.isArray(schema.required)
          || schema.required.some((field) => typeof field !== "string")) {
          throw new TypeError(`${path}.required must be an array of strings`);
        }
        for (const field of schema.required) {
          if (!Object.hasOwn(value, field)) errors.push(`${path} requires ${field}`);
        }
      }
      const properties = schema.properties ?? {};
      if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
        throw new TypeError(`${path}.properties must be an object`);
      }
      for (const [field, fieldValue] of Object.entries(value)) {
        if (Object.hasOwn(properties, field)) {
          validate(properties[field], fieldValue, `${path}.${field}`);
        } else if (schema.additionalProperties === false) {
          errors.push(`${path} does not allow ${field}`);
        } else if (schema.additionalProperties
          && typeof schema.additionalProperties === "object") {
          validate(schema.additionalProperties, fieldValue, `${path}.${field}`);
        }
      }
    }
  };
  validate(schemaValue, instance, "$");
  return { valid: errors.length === 0, errors };
}

function assertSchemaReferences(schema, rootSchema, label, seen = new Set()) {
  if (schema === true || schema === false) return;
  const value = requiredObject(schema, label);
  if (seen.has(value)) return;
  seen.add(value);
  if (value.$ref !== undefined) {
    const referenced = resolveJsonPointer(rootSchema, value.$ref, `${label}.$ref`);
    assertSchemaReferences(referenced, rootSchema, `${label}.$ref target`, seen);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" || child === null || typeof child !== "object") continue;
    if (Array.isArray(child)) {
      child.forEach((entry, index) => {
        if (entry && typeof entry === "object") {
          assertSchemaReferences(entry, rootSchema, `${label}.${key}[${index}]`, seen);
        }
      });
    } else {
      assertSchemaReferences(child, rootSchema, `${label}.${key}`, seen);
    }
  }
}

function resolveContractRef(contract, pointer, operation) {
  try {
    return resolveJsonPointer(
      contract,
      pointer,
      `operation catalog operation '${operation}' contractRef`,
    );
  } catch {
    throw new TypeError(`operation catalog operation '${operation}' contractRef does not resolve`);
  }
}

function validateOperationCatalog(value, options) {
  const catalog = requiredObject(value, "operation catalog");
  if (catalog.schema !== AGENT_OPERATION_CATALOG_SCHEMA
    || catalog.package !== options.packageName
    || catalog.productProtocol !== options.productProtocol
    || catalog.agentProtocol !== options.agentProtocol
    || catalog.command?.operationField !== "op"
    || catalog.command?.argumentsField !== AGENT_JSONL_ARGUMENTS_FIELD) {
    throw new Error("Agent operation catalog identity or command envelope is invalid");
  }
  if (!Array.isArray(catalog.operations) || catalog.operations.length < 1) {
    throw new TypeError("operation catalog operations must be a non-empty array");
  }
  if (catalog.jsonSchemaDialect !== "https://json-schema.org/draft/2020-12/schema") {
    throw new Error("Agent operation catalog must use JSON Schema draft 2020-12");
  }
  const sharedSchemas = requiredObject(catalog.schemas, "operation catalog schemas");
  for (const name of ["error", "successResult", "errorResult", "resultEnvelope"]) {
    const schema = requiredObject(sharedSchemas[name], `operation catalog schemas.${name}`);
    assertSchemaReferences(schema, catalog, `operation catalog schemas.${name}`);
  }
  const names = [];
  for (const [index, operation] of catalog.operations.entries()) {
    const entry = requiredObject(operation, `operation catalog operations[${index}]`);
    names.push(requiredText(entry.op, `operation catalog operations[${index}].op`));
    if (!["lifecycle", "product", "control"].includes(entry.kind)) {
      throw new TypeError(`operation catalog operations[${index}].kind is invalid`);
    }
    const effects = requiredStringArray(
      entry.effects,
      `operation catalog operations[${index}].effects`,
    );
    if (effects.some((effect) => !AGENT_OPERATION_EFFECTS.has(effect))) {
      throw new TypeError(`operation catalog operation '${entry.op}' has an unknown effect`);
    }
    requiredStringArray(entry.requires, `operation catalog operations[${index}].requires`);
    const args = requiredObject(entry.args, `operation catalog operations[${index}].args`);
    const required = requiredStringArray(
      args.required,
      `operation catalog operations[${index}].args.required`,
    );
    const optional = requiredStringArray(
      args.optional,
      `operation catalog operations[${index}].args.optional`,
    );
    if (required.some((field) => optional.includes(field))) {
      throw new TypeError(`operation catalog operation '${entry.op}' repeats an args field`);
    }
    const documentedFields = new Set([...required, ...optional]);
    if ([...documentedFields].some((field) => ["id", "op", "args"].includes(field))) {
      throw new TypeError(`operation catalog operation '${entry.op}' documents a reserved field`);
    }
    if (args.requiredAnyOf !== undefined) {
      if (!Array.isArray(args.requiredAnyOf)) {
        throw new TypeError(`operation catalog operation '${entry.op}' requiredAnyOf is invalid`);
      }
      for (const [groupIndex, group] of args.requiredAnyOf.entries()) {
        requiredStringArray(
          group,
          `operation catalog operation '${entry.op}' requiredAnyOf[${groupIndex}]`,
        );
        if (group.length < 1) {
          throw new TypeError(`operation catalog operation '${entry.op}' requiredAnyOf is empty`);
        }
        if (group.some((field) => !documentedFields.has(field))) {
          throw new TypeError(
            `operation catalog operation '${entry.op}' requiredAnyOf is not documented`,
          );
        }
      }
    }
    const argsSchema = requiredObject(
      entry.argsSchema,
      `operation catalog operation '${entry.op}' argsSchema`,
    );
    const resultSchema = requiredObject(
      entry.resultSchema,
      `operation catalog operation '${entry.op}' resultSchema`,
    );
    if (argsSchema.type !== "object" || argsSchema.additionalProperties !== false) {
      throw new TypeError(
        `operation catalog operation '${entry.op}' argsSchema must be a closed object`,
      );
    }
    const schemaFields = Object.keys(requiredObject(
      argsSchema.properties,
      `operation catalog operation '${entry.op}' argsSchema.properties`,
    ));
    if (JSON.stringify(schemaFields) !== JSON.stringify([...required, ...optional])
      || JSON.stringify(argsSchema.required ?? []) !== JSON.stringify(required)) {
      throw new Error(
        `operation catalog operation '${entry.op}' argsSchema does not match args metadata`,
      );
    }
    assertSchemaReferences(argsSchema, catalog, `operation '${entry.op}' argsSchema`);
    assertSchemaReferences(resultSchema, catalog, `operation '${entry.op}' resultSchema`);
    const examples = requiredObject(
      entry.examples,
      `operation catalog operation '${entry.op}' examples`,
    );
    const validExample = validateAgentJsonSchemaInstance(
      argsSchema,
      examples.validArgs,
      catalog,
    );
    if (!validExample.valid) {
      throw new Error(
        `operation catalog operation '${entry.op}' validArgs failed: ${validExample.errors.join("; ")}`,
      );
    }
    const invalidExample = validateAgentJsonSchemaInstance(
      argsSchema,
      examples.invalidArgs,
      catalog,
    );
    if (invalidExample.valid) {
      throw new Error(`operation catalog operation '${entry.op}' invalidArgs unexpectedly passed`);
    }
    const pointers = requiredObject(
      entry.schemaPointers,
      `operation catalog operation '${entry.op}' schemaPointers`,
    );
    if (pointers.args !== `#/operations/${index}/argsSchema`
      || pointers.result !== `#/operations/${index}/resultSchema`) {
      throw new Error(`operation catalog operation '${entry.op}' schemaPointers are invalid`);
    }
    const contractRef = requiredText(
      entry.contractRef,
      `operation catalog operation '${entry.op}' contractRef`,
    );
    if (!contractRef.startsWith("#/")) {
      throw new TypeError(`operation catalog operation '${entry.op}' contractRef is invalid`);
    }
    const operationContract = requiredObject(
      resolveContractRef(options.contract, contractRef, entry.op),
      `operation catalog operation '${entry.op}' contract`,
    );
    const resource = options.contract.agentInterop?.operationCatalog?.resource;
    if (operationContract.operation !== entry.op
      || operationContract.kind !== entry.kind
      || JSON.stringify(operationContract.effects) !== JSON.stringify(entry.effects)
      || JSON.stringify(operationContract.requires) !== JSON.stringify(entry.requires)
      || operationContract.argsSchemaRef !== `${resource}${pointers.args}`
      || operationContract.resultSchemaRef !== `${resource}${pointers.result}`) {
      throw new Error(`operation catalog operation '${entry.op}' contract is not in parity`);
    }
  }
  if (new Set(names).size !== names.length) {
    throw new TypeError("operation catalog operation names must be unique");
  }
  const advertised = requiredStringArray(
    options.advertisedOperations,
    "descriptor capabilities.operations.jsonl",
  );
  if (JSON.stringify(names) !== JSON.stringify(advertised)) {
    throw new Error("Agent operation catalog does not match live JSONL operations");
  }
  const safeProbe = requiredObject(catalog.safeProbe, "operation catalog safeProbe");
  const safeOperation = catalog.operations.find((entry) => entry.op === safeProbe.op);
  if (!safeOperation
    || !safeProbe.args
    || typeof safeProbe.args !== "object"
    || Array.isArray(safeProbe.args)) {
    throw new TypeError("operation catalog safeProbe must name one catalog operation with args");
  }
  const safeEffects = requiredStringArray(safeProbe.effects, "operation catalog safeProbe.effects");
  const safeRequires = requiredStringArray(
    safeProbe.requires,
    "operation catalog safeProbe.requires",
  );
  if (safeRequires.some((requirement) => !safeOperation.requires.includes(requirement))) {
    throw new TypeError("operation catalog safeProbe requires an undocumented prerequisite");
  }
  if (safeEffects.some((effect) => [
    "external-write",
    "filesystem-write",
    "caller-dependent",
    "local-state",
    "process-control",
    "process-lifecycle",
  ].includes(effect))) {
    throw new TypeError("operation catalog safeProbe must not advertise a mutating effect");
  }
  const safeFields = Object.keys(safeProbe.args);
  const documentedSafeFields = new Set([
    ...safeOperation.args.required,
    ...safeOperation.args.optional,
  ]);
  if (safeOperation.args.required.some((field) => !Object.hasOwn(safeProbe.args, field))
    || safeFields.some((field) => !documentedSafeFields.has(field))
    || (safeOperation.args.requiredAnyOf ?? []).some(
      (group) => !group.some((field) => Object.hasOwn(safeProbe.args, field)),
    )) {
    throw new TypeError("operation catalog safeProbe does not satisfy its documented args");
  }
  const safeValidation = validateAgentJsonSchemaInstance(
    safeOperation.argsSchema,
    safeProbe.args,
    catalog,
  );
  if (!safeValidation.valid) {
    throw new TypeError(
      `operation catalog safeProbe violates argsSchema: ${safeValidation.errors.join("; ")}`,
    );
  }
  if (options.contract.wireProtocolContract !== undefined) {
    const wire = requiredObject(
      options.contract.wireProtocolContract,
      "contract.wireProtocolContract",
    );
    const methods = requiredObject(wire.methods, "contract.wireProtocolContract.methods");
    const nested = requiredObject(catalog.nestedOperations, "operation catalog nestedOperations");
    const nestedPointer = requiredText(
      nested.contractRef,
      "operation catalog nestedOperations.contractRef",
    ).split("#").at(-1);
    if (wire.protocol !== options.contract.wireProtocol
      || nestedPointer !== "/wireProtocolContract/methods"
      || JSON.stringify(nested.methods) !== JSON.stringify(Object.keys(methods))) {
      throw new Error("MoneyHand nested wire-operation discovery is not in parity");
    }
    for (const [method, definition] of Object.entries(methods)) {
      const entry = requiredObject(definition, `wire operation '${method}'`);
      requiredStringArray(entry.effects, `wire operation '${method}'.effects`);
      assertSchemaReferences(
        requiredObject(entry.paramsSchema, `wire operation '${method}'.paramsSchema`),
        wire,
        `wire operation '${method}'.paramsSchema`,
      );
      assertSchemaReferences(
        requiredObject(entry.resultSchema, `wire operation '${method}'.resultSchema`),
        wire,
        `wire operation '${method}'.resultSchema`,
      );
    }
    const requestOperation = catalog.operations.find((entry) => entry.op === "request");
    if (!requestOperation
      || !sameJsonValue(requestOperation.argsSchema.properties.request, wire.requestSchema)) {
      throw new Error("MoneyHand request argsSchema does not match the packaged wire contract");
    }
  }
  return catalog;
}

export async function createAgentCliDescriptor(options = {}) {
  const input = requiredObject(options, "descriptor options");
  const capabilities = requiredObject(input.capabilities, "descriptor capabilities");
  const packageName = requiredText(input.packageName, "descriptor packageName");
  const [contract, rawOperationCatalog] = await Promise.all([
    readFile(input.contractUrl, "utf8").then(JSON.parse),
    readFile(input.operationCatalogUrl, "utf8").then(JSON.parse),
  ]);
  const packageVersion = requiredText(contract.version, "contract.version");
  const productProtocol = requiredText(capabilities.protocol, "capabilities.protocol");
  const agentProtocol = requiredText(
    capabilities.agentInterop?.protocol,
    "capabilities.agentInterop.protocol",
  );
  const wireProtocol = requiredText(
    capabilities.wireProtocol ?? capabilities.hand?.protocol,
    "capabilities.wireProtocol",
  );
  const contractProductProtocol = contract.controlProtocol ?? contract.protocol;
  if (contract.package !== packageName) {
    throw new Error("Agent contract package identity does not match the executable");
  }
  if (contractProductProtocol !== productProtocol
    || contract.agentInterop?.protocol !== agentProtocol
    || contract.wireProtocol !== wireProtocol) {
    throw new Error("Agent contract protocols do not match live capabilities");
  }
  if (JSON.stringify(contract.agentInterop?.operationCatalog)
    !== JSON.stringify(capabilities.agentInterop?.operationCatalog)) {
    throw new Error("Agent operation catalog discovery metadata does not match live capabilities");
  }
  if (contract.transports?.discovery?.schema !== AGENT_CLI_DESCRIPTOR_SCHEMA) {
    throw new Error("Agent contract does not declare the common CLI discovery schema");
  }
  const transports = requiredObject(capabilities.transports, "capabilities.transports");
  const operationCatalog = validateOperationCatalog(rawOperationCatalog, {
    packageName,
    productProtocol,
    agentProtocol,
    contract,
    advertisedOperations: capabilities.operations?.jsonl,
  });
  return {
    schema: AGENT_CLI_DESCRIPTOR_SCHEMA,
    product: {
      name: requiredText(input.name, "descriptor name"),
      package: packageName,
      version: packageVersion,
      executable: requiredText(input.executable, "descriptor executable"),
    },
    protocols: {
      agent: agentProtocol,
      product: productProtocol,
      wire: wireProtocol,
    },
    modes: {
      programmatic: transports.programmatic === true || transports.esm === true,
      persistentJsonl: transports.jsonl?.persistent === true,
      oneShot: transports.jsonl?.oneShot === true,
      taskModule: transports.taskModule?.security === "trusted-local-code",
    },
    runtime: {
      node: hostProcess.versions.node,
      platform: hostProcess.platform,
      arch: hostProcess.arch,
    },
    discovery: {
      readOnly: true,
      consumesStdin: false,
      startsListener: false,
      startsPlatformWorker: false,
      requiresBrowserSession: false,
      requiresDesktopPermissions: false,
      filesystemWrites: false,
      inputSideEffect: false,
      modelRuntime: false,
    },
    capabilities,
    contract,
    operationCatalog,
  };
}

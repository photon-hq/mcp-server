import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { closeSchema } from "../schema.js";
import type { PathOperation } from "./schema.js";

const validator = new CfWorkerJsonSchemaValidator({ draft: "2020-12" });

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function consumePinnedHeaders(
  pathOperation: PathOperation,
  components: unknown,
  pinnedHeaders: Readonly<Record<string, string>>
): PathOperation {
  if (Object.keys(pinnedHeaders).length === 0) {
    return pathOperation;
  }
  const { operation, method, pathTemplate } = pathOperation;
  const retain = (parameter: unknown) => {
    if (
      !isRecord(parameter) ||
      parameter.in !== "header" ||
      typeof parameter.name !== "string" ||
      !Object.hasOwn(pinnedHeaders, parameter.name.toLowerCase())
    ) {
      return true;
    }
    const value = pinnedHeaders[parameter.name.toLowerCase()];
    const operationId =
      typeof operation.operationId === "string"
        ? operation.operationId
        : `${method} ${pathTemplate}`;
    const message = `pinned_header_rejected_by_operation: ${operationId}: ${parameter.name}=${JSON.stringify(value)}`;
    try {
      const schema = closeSchema(
        {
          properties: { header: parameter.schema },
          required: ["header"],
          type: "object",
        },
        components
      );
      if (validator.getValidator(schema)({ header: value }).valid) {
        return false;
      }
    } catch (cause) {
      throw new Error(message, { cause });
    }
    throw new Error(message);
  };
  return {
    ...pathOperation,
    operation: Array.isArray(operation.parameters)
      ? { ...operation, parameters: operation.parameters.filter(retain) }
      : operation,
    pathParameters: pathOperation.pathParameters.filter(retain),
  };
}

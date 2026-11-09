import type { FastifySerializerCompiler } from "fastify";
import fastJsonStringify, { type Schema } from "fast-json-stringify";

/** Keep the large receipt unions' first-use AJV compilation off the expensive
 * code-optimization path. Schema validation and response projection stay in
 * fast-json-stringify; this changes generated-code optimization only.
 *
 * One compiler belongs to one server instance. Routes sharing a response schema
 * also share its serializer and lazily compiled union validators.
 */
export function createReceiptSerializerCompiler(): FastifySerializerCompiler<object> {
  const serializers = new WeakMap<object, (data: unknown) => string>();
  return ({ schema }) => {
    let serialize = serializers.get(schema);
    if (!serialize) {
      // FJS accepts root unions although its Schema type requires `type`.
      serialize = fastJsonStringify(schema as Schema, { ajv: { code: { optimize: false } } });
      serializers.set(schema, serialize);
    }
    return serialize;
  };
}

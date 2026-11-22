// The same appDescriptorSchema, rendered as JSON Schema. Zod generates it, so
// it cannot drift from the validator. Editors can use the output to validate
// apps/<app>/app.json; CI can publish it too.

import { z } from "zod";
import { appDescriptorSchema } from "./app.ts";

export function descriptorJsonSchema(): unknown {
  return z.toJSONSchema(appDescriptorSchema, {
    // The semantic pass adds checks the schema cannot express; anything Zod
    // cannot represent is emitted as permissive JSON Schema rather than
    // failing the command.
    unrepresentable: "any",
  });
}

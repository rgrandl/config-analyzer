// YAML text → plain JavaScript value. Structure is checked afterwards by validate.ts.
import { parseDocument } from 'yaml';
import { fail, ok, type Result } from './result';

/** Parses YAML. Syntax errors (including duplicate keys) are returned with their line, never thrown. */
export function parseYaml(text: string): Result<unknown> {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    return fail(
      doc.errors.map((error) => ({
        path: '',
        // The library's message starts with a one-line summary that already names the line and column.
        message: error.message.split('\n')[0] ?? error.message,
      })),
    );
  }
  return ok(doc.toJS());
}

// Lets TypeScript understand `import sql from "./schema.sql" with { type:
// "text" }` - Bun inlines the file content as a string at build time, both
// in dev and in compiled (`bun build --compile`) executables.
declare module "*.sql" {
  const content: string;
  export default content;
}

# Todo CLI

A small sequential project: scaffold → implement → test. Good first example of `/dag-plan`.

## Prompt

```text
/dag-plan Build a todo CLI in Node.js (ESM, zero dependencies).
- Commands: add <text>, list, done <id>, rm <id>
- Store todos in todos.json in the current working directory (create it on first add)
- list prints aligned "id  [x] text" lines; done and rm update the file and print the updated line
- Entry point: bin/todo.js with a shebang; wire the "bin" field in package.json
- Tests: node:test in test/todo.test.js covering each command plus the empty-list case; `npm test` must pass
```

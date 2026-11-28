// Policy sentences for `forge know --enforce`. TUNING set: written first and used while building
// compileRule. [sentence, expected]: expected = "kind:subject[:dir]", or null when it must NOT
// compile. Known packages for this set: lodash, moment, axios.
export const TUNING = [
  ["Never import moment", "no-import:moment"],
  ["Don't use lodash in src", "no-import:lodash:src"],
  ["Use pnpm, not npm", "no-file:package-lock.json"],
  ["Prefer date-fns over moment", "no-import:moment"],
  ["No console.log in src", "no-text:console.log:src"],
  ["Never use var", "no-text:var declarations"],
  ["Avoid default exports", "no-text:default exports"],
  ["Do not use eval", "no-text:eval()"],
  ['Never commit "localhost:3000"', "no-text:localhost:3000"],
  ["axios is banned", "no-import:axios"],
  ["Don't use the any type", "no-text:the any type"],
  ["No it.only in tests", "no-text:.only in tests:tests"],
  ["Use yarn instead of npm", "no-file:package-lock.json"],
  ["Never import @prisma/client in app/components", "no-import:@prisma/client:app/components"],
  // must NOT compile: prose policies with no checkable shape
  ["Always run the tests before committing", null],
  ["Keep functions small", null],
  ["Prefer composition over inheritance", null],
  ["Never use magic numbers", null],
  ["Write commit messages in the imperative mood", null],
  ["Don't use abbreviations in names", null],
  ["Ask before deleting files", null],
  ["Use descriptive variable names", null],
];

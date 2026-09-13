const { createStorage } = require("../storage");

(async () => {
  const result = await createStorage().check();
  console.log(JSON.stringify(result, null, 2));
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { startDurableServer } from "../../src/index.ts";

const [cwd, databasePath] = process.argv.slice(2);
if (!cwd || !databasePath) throw new Error("Test fixture paths required");
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([async () => {
  console.log("model-started");
  return new Promise<never>(() => {});
}]);
const server = await startDurableServer({ cwd, databasePath, models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id }, port: 0 });
console.log(JSON.stringify({ url: server.url, epoch: server.epoch }));

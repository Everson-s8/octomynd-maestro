import { runConfigWizard } from "./config/wizard.js";

const result = runConfigWizard();
console.log(result.summary);

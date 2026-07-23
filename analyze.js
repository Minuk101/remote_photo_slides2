import { VisitAnalysisService } from './analysis-engine.js';

const service = new VisitAnalysisService();
await service.load();
if (process.argv.includes('--labels-only')) await service.refreshLabels();
else await service.refresh({ force: process.argv.includes('--force') });
console.log(JSON.stringify(service.status(), null, 2));

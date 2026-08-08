import { VisitAnalysisService } from './analysis-engine.js';

const service = new VisitAnalysisService();
await service.load();
if (process.argv.includes('--retag-jeju')) {
  await service.forgetLocationsInBounds({ minLatitude: 33.1, maxLatitude: 33.65, minLongitude: 126.1, maxLongitude: 127.0 });
  await service.refresh({ force: true });
} else if (process.argv.includes('--labels-only')) await service.refreshLabels();
else await service.refresh({ force: process.argv.includes('--force') });
console.log(JSON.stringify(service.status(), null, 2));

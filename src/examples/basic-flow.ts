import { runBasicFlow } from '../coordinator';

const result = await runBasicFlow();

for (const item of result.timeline) {
  console.log(`${item.name}: ${item.id}`);
}

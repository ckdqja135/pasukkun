// 서버의 OpenAPI 명세(openapi.json)에서 생성한 타입을 다시 내보낸다.
// 직접 고치지 말고 저장소 루트에서 `pnpm openapi` 를 실행해 갱신한다.
import type { components, paths } from './schema.js';

export type { components, paths };
export type Schemas = components['schemas'];

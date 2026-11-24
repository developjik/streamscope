# streamscope

[English](README.md) · 한국어

**AI 스트리밍 UI를 프레임 단위로 녹화하고, 재생하고, 일부러 망가뜨립니다.**

[![CI](https://github.com/developjik/streamscope/actions/workflows/ci.yml/badge.svg)](https://github.com/developjik/streamscope/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-informational)](https://nodejs.org)

토큰·툴 호출·승인을 스트리밍하는 채팅 UI에는 *프레임 사이*에만 존재하는 상태가 있습니다. 그게 깨질 때 — 툴 인자가 절반만 파싱된 채 도착하고, 토큰이 중복되고, 소켓이 62% 지점에서 죽을 때 — 실패는 새로고침하는 순간 사라지고 아무도 재현하지 못합니다.

`streamscope`는 앱과 모델 서버 사이에 녹화 프록시로 앉아서, 모든 와이어 프레임을 타이밍과 함께 저장하고, **장애를 주입한 상태로** 결정적으로 재생합니다. 같은 녹화본이 Playwright 픽스처가 되므로 "스트림이 여기서 끊겼을 때 UI가 깨졌다"가 CI에서 도는 테스트가 됩니다.

```
┌───────────┐   SSE / NDJSON    ┌──────────────────────┐   recorded frames   ┌────────────────────────────┐
│  browser  │ ◀───────────────▶ │  streamscope record  │ ──────────────────▶ │ .streams/<session>/        │
│  (your    │   reverse proxy   │  adapter: ai-sdk /   │                     │   events.jsonl             │
│   app)    │                   │  ag-ui / legacy /    │                     └─────────────┬──────────────┘
└───────────┘                   │  generic             │                                   │
                                └──────────────────────┘                                   │
                                                                                           ▼
┌──────────────────┐   replay + faults   ┌──────────────────────┐   same frames, injected  ┌────────────────┐
│ timeline panel   │ ◀────────────────── │  streamscope replay  │ ◀─────────────────────── │ fault DSL      │
│ scrub · text ·   │                     │  local HTTP server   │                          │ drop/dup/      │
│ tool args · break│                     └──────────┬───────────┘                          │ truncate/...   │
└──────────────────┘                                │                                      └────────────────┘
                                                    ▼
                                     ┌──────────────────────────────┐
                                     │ Playwright: replayStream()   │
                                     │ route the app's real request │
                                     │ to the replay server         │
                                     └──────────────────────────────┘
```

## 왜 이게 필요한가

에이전트 프론트엔드는 이제 스트림 위에 올라갑니다(AI SDK UI, AG-UI, 직접 만든 SSE). 그런데 디버깅 도구는 "이벤트를 보여줘"에서 멈춥니다. DevTools 패널은 SSE 프레임을 보여주고, Playwright 트레이스는 DOM과 액션을 재생하며, MSW는 스트림 의미론 없이 HTTP만 목킹합니다. 실제로 올라오는 버그는 스트림의 *상태 경계*에 관한 것입니다 — 예를 들어 AG-UI의 [구독자가 메시지를 교체할 때 툴 호출 인자 청크가 드롭되는 문제](https://github.com/ag-ui-protocol/ag-ui/issues/3264), [중단된 서브에이전트의 스냅샷이 undefined가 되는 문제](https://github.com/ag-ui-protocol/ag-ui/issues/3312) 같은 것입니다. 이런 걸 재현하려면 정확한 프레임 시퀀스와, 그것을 일부러 깨뜨릴 수 있는 능력이 필요합니다.

streamscope는 테스트 프레임워크도 모니터링 패널도 아닙니다. 녹화기이자 실험대입니다. 세션을 녹화하고, UI가 죽은 프레임을 재생하고, 장애를 주입하고, 결과를 픽스처로 남기세요.

## 설치

```bash
# 체험에는 설치할 것이 없습니다
npx streamscope --help

# 개발 의존성으로 (라이브러리 + Playwright 픽스처)
npm install --save-dev streamscope
npm install --save-dev playwright   # 픽스처의 page 객체에만 필요
```

Node ≥ 20이 필요합니다. 런타임 의존성은 없습니다.

## 60초 투어

```bash
git clone https://github.com/developjik/streamscope && cd streamscope
npm install && npm run build

# 1. 번들 데모 앱 실행 (작은 스트리밍 에이전트 UI, 와이어 프로토콜 4종)
npm run demo            # http://127.0.0.1:8790

# 2. 녹화 — 앱 URL이 아니라 프록시 URL을 연다
npx streamscope record --target http://127.0.0.1:8790
#   streamscope proxy: http://127.0.0.1:8787 -> http://127.0.0.1:8790
#   recorded 16 frames (ai-sdk) -> .streams/2026-11-21T14-09-10-4a2e/events.jsonl

# 3. 무엇이 담겼는지 확인
npx streamscope inspect .streams/<session>
#   frames    16 over 84 ms, 1359 wire bytes
#   events    text-delta=7 tool-call-delta=5 tool-result=1 approval=1 finish=1
#   tools
#     - track_shipment [call_track_1] 40B args (valid JSON) +result

# 4. 망가뜨려서 재생, 타임라인 패널과 함께
npx streamscope replay .streams/<session> --inject "drop(3),disconnect_at(0.62)"
#   replay: http://127.0.0.1:8788/stream
#   panel:  http://127.0.0.1:8788/
```

`demo/traces/`에는 이미 실제 프록시를 거쳐 데모 앱에서 녹화한 트레이스가 있으므로 곧바로 `replay demo/traces/chat-ai-sdk.jsonl`로 넘어가도 됩니다.

## 무엇이 녹화되는가

세션마다 파일 하나, `.streams/<session>/events.jsonl`: 메타 한 줄, 그다음 **와이어 프레임**(SSE 메시지 하나 또는 NDJSON 줄 하나)마다 한 줄.

```json
{"v":1,"kind":"meta","session":"chat-ai-sdk","adapter":"ai-sdk","framing":"sse","protocol":"ai-sdk",
 "startedAt":"2026-11-21T14:09:10.434Z","request":{"method":"GET","url":"http://127.0.0.1:8791/api/chat?fast=1"},
 "response":{"status":200,"contentType":"text/event-stream; charset=utf-8"}}
{"t_ms":0,"seq":0,"raw":"data: {\"type\":\"start\",\"messageId\":\"msg_demo_1\"}\n\n","event":{"type":"run-start","name":"start"}}
{"t_ms":0,"seq":1,"raw":"data: {\"type\":\"text-delta\",\"id\":\"msg_demo_1\",\"delta\":\"Sure — \"}\n\n","event":{"type":"text-delta","id":"msg_demo_1","delta":"Sure — "}}
{"t_ms":12,"seq":2,"raw":"data: {\"type\":\"tool-input-delta\",\"toolCallId\":\"call_track_1\",\"inputTextDelta\":\"{\\\"order\"}\n\n","event":{"type":"tool-call-delta","id":"call_track_1","argsDelta":"{\"order"}}
```

- `t_ms` — 첫 녹화 프레임으로부터의 밀리초. 절대 줄어들지 않습니다.
- `raw` — 정규화된 텍스트 형태의 와이어 프레임. 재생이 앱에 되돌려 쓰는 것이 바로 이것입니다.
- `event` — 정규화된 의미 이벤트. 나머지(패널, 장애, 요약)는 이 위에서 동작합니다.

정규화된 이벤트: `text-delta`, `tool-call-delta`, `tool-result`, `approval`, `error`, `finish`, 그리고 프로토콜 배관용 `run-start`, `lifecycle`, `unknown`.

### 어댑터

| 와이어 포맷 | 감지 이름 | 비고 |
|---|---|---|
| Vercel AI SDK **UI message stream** (SSE, `{"type":"text-delta"}` / `tool-input-delta` / `tool-output-available` / `error` / `finish`) | `ai-sdk` | AI SDK 챗봇 UI의 기본값 |
| Vercel AI SDK **legacy data stream** (`0:"text"`, `9:{toolCall}`, `a:{result}`, `3:"error"`, `d:{finish}`) | `ai-sdk-data` | 대개 NDJSON |
| SSE 위의 **AG-UI** 이벤트 (`RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, `TOOL_CALL_ARGS`, `TOOL_CALL_RESULT`, `RUN_ERROR`, `RUN_FINISHED`) | `ag-ui` | 대문자 이벤트 이름 |
| `{"type": ...}` 또는 `delta`/`text`/`content`가 있는 아무 SSE/NDJSON | `generic` | 최선 노력 매핑 |
| `text/plain` 토큰 스트림 | `raw` 프레이밍 | 청크마다 `text-delta` 하나 |
| 단일 JSON 응답 | `json` 프레이밍 | 한 프레임으로 녹화되므로 "스트림이 아예 없음"도 드러납니다 |

프레이밍은 먼저 콘텐츠 타입에서 감지하고(`--adapter`로 `sse`, `ndjson`, `json`, `auto`를 강제할 수 있음), 그다음 첫 바이트에서 감지합니다. 파싱은 청크 경계에 안전합니다: TCP 읽기 사이에서 쪼개진 `data:` 줄, CRLF, 홑 CR, 주석, 여러 줄 `data:`를 모두 처리합니다.

## 장애 DSL

인덱스는 **녹화된 트레이스의 0부터 시작하는 프레임 인덱스**이므로 장애를 적는 순서가 결과를 바꾸지 않습니다. 적용 순서는 고정입니다: `truncate → drop → dup → reorder → disconnect → error → slow`.

| 장애 | 의미 |
|---|---|
| `drop(3)` | 프레임 #3 드롭 |
| `drop(2..5)` | 프레임 #2부터 #5까지 드롭 |
| `dup(7)` | 프레임 #7을 두 번 전송 (전형적인 중복 토큰 버그) |
| `truncate_tool_args(12)` | 모든 툴 인자 조각을 12바이트로 잘라, 툴 UI를 깨뜨리는 반쯤 파싱된 JSON을 만듦 |
| `truncate_tool_args(12,4)` | …프레임 #4에만 |
| `disconnect_at(0.62)` | 프레임의 62% 지점에서, 터미널 이벤트 없이 연결을 닫음 |
| `error(429)` | 에러 프레임(429)으로 스트림을 끝냄 |
| `error(429,5)` | 프레임 #0–#4는 유지하고, 그다음 429로 실패 |
| `slow(800)` | 모든 프레임 전에 800ms 추가 (멈춘 토큰) |
| `slow(800,3)` | 프레임 #3 전에 800ms 추가 |
| `reorder(2,5)` | 프레임 #2와 #5를 맞바꿈 (순서가 뒤집힌 툴 인자) |

시나리오는 쉼표나 세미콜론으로 조합합니다: `--inject "drop(3), dup(7), disconnect_at(0.62)"`. 잘못된 장애는 이유와 함께 실패합니다(`drop(99)` → `out of range — the trace has 16 frame(s)`). 조용히 넘어가는 일은 없습니다.

모든 인덱스는 녹화 원본의 0부터 시작하는 위치를 가리킵니다. 여러 `drop`은 원본 위치의 합집합을 제거하며, 겹치거나 반복된 범위는 이미 제거한 프레임을 다시 세지 않습니다. `drop`으로 제거한 프레임의 `dup`은 건너뛰고 복원하지 않습니다. 살아 있는 프레임의 `dup`에는 앞서 적용한 도구 인자 잘림도 그대로 반영됩니다. 순번(`seq`)이 중복되어도 원본 위치로 구별합니다. `error(status,index)`는 대상 프레임이 삭제되거나 재정렬되어도 지정한 원본 위치보다 앞선 생존 프레임만 남깁니다. 결함 종류의 적용 순서는 고정이지만, 같은 종류의 겹치는 `reorder`는 작성 순서를 따릅니다.


시나리오를 새 픽스처로 구워 넣기:

```bash
npx streamscope inject demo/traces/chat-ai-sdk.jsonl \
  --with "truncate_tool_args(6),error(429)" -o demo/traces/chat-ai-sdk.broken.jsonl
```

## CLI

```
streamscope record --target http://localhost:3000 [--port 8787] [--out .streams]
                   [--adapter auto|sse|ndjson|json] [--include <regex>] [--ignore <regex>] [--no-redact] [--quiet]

streamscope replay <trace|session-dir> [--port 8788] [--speed 1] [--inject "<dsl>"] [--no-ui]

streamscope inject <trace> --with "<dsl>" [-o out.jsonl] [--print]

streamscope inspect <trace> [--json] [--html viewer.html] [--frames]

streamscope --help | --version
```

- `record`는 리버스 프록시입니다: 브라우저(또는 Playwright, curl)를 프록시 URL로 향하게 하면 녹화 가능한 모든 응답이 파싱되면서 그대로 스트리밍됩니다. 정적 자산은 건너뛰고, `--include`/`--ignore`는 정규식을 받습니다. 같은 코드가 Express/Connect 서버용 `createMiddleware()`로도 내보내집니다. 자격 증명 헤더(`authorization`, `cookie`, `set-cookie`, `x-api-key`, `proxy-authorization`)는 트레이스에 `[redacted]`로 저장됩니다 — `--no-redact`는 그대로 녹화하고 경고를 출력합니다. `http:`·`https:` 타깃만 지원하며 다른 스킴은 시작 단계에서 거부됩니다.
- `replay`는 `GET /stream`(녹화된 타이밍, 또는 즉시 재생은 `--speed 0`), `GET /`(패널), `GET /trace.json`(플랜 + 프레임)을 서빙합니다. `disconnect_at` 플랜은 소켓을 파괴하고, 프레임 0에서 실패하는 `error` 플랜은 평범한 HTTP 에러로 응답합니다.
- `inspect`는 요약하거나, 버그 리포트에 첨부할 수 있는 독립형 HTML 패널을 씁니다.

## Playwright 픽스처

```ts
import { test, expect } from '@playwright/test';
import { replayStream } from 'streamscope/playwright';

test('the UI does not lose the tool card when a chunk is dropped', async ({ page }) => {
  // Serve the recorded stream to the app's real /api/chat request.
  const stream = await replayStream(page, 'demo/traces/chat-ai-sdk.jsonl', {
    url: '**/api/chat*',
    inject: ['drop(3)', 'disconnect_at(0.62)'],
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('stream interrupted')).toBeVisible();
  await expect(page.getByRole('status', { name: /tracking/ })).toHaveCount(1);
  await stream.stop();
});
```

동작 방식: 로컬 재생 서버가 (장애가 주입된) 프레임을 녹화된 타이밍으로 스트리밍하고, 페이지의 요청은 네트워크 계층에서 `route.continue({ url })`로 그쪽으로 재라우팅됩니다. 앱은 여전히 자기 엔드포인트와 대화한다고 믿으므로 스트리밍, 스트림 중간 중단, 에러 프레임이 프로덕션처럼 동작합니다. `transport: 'fulfill'`은 본문 하나를 통째로 보내고(스트리밍 없음), `abort: true`는 요청을 네트워크 계층에서 실패시킵니다.

| 옵션 | 기본값 | |
|---|---|---|
| `url` | `'**/api/**'` | 가로챌 라우트 패턴 |
| `inject` | `[]` | DSL 문자열 또는 파싱된 장애 |
| `speed` | `0` | `1` = 녹화된 타이밍, `10` = 10배, `0` = 대기 없음 |
| `transport` | `'continue'` | 본문 하나로 보내려면 `'fulfill'` |
| `abort` | `false` | 재생 대신 요청 중단 |

핸들은 `plan`(프레임 + 효과 + 결과), `url`/`streamUrl`, `requests`, `done`, `stop()`을 노출합니다. `page.route` / `page.unroute`만 사용하므로 이 패키지에는 Playwright 의존성이 없습니다.

## 타임라인 패널

`replay`가 서빙하고(`inspect --html`이 기록하는) 자체 완결형 HTML 파일 하나:

- `t_ms`, 타입 배지, 한 줄 미리보기가 붙은 프레임 목록, 키보드 `←`/`→`, 재생은 스페이스;
- *그 프레임 시점의* UI 상태를 복원하는 스크러버: 누적 텍스트, JSON 유효 / 미완성 표시가 붙은 툴 호출 인자 조립, 승인, 결과;
- 깨진 지점: 에러 프레임, 또는 `finish` 없이 끝난 스트림;
- 선택한 프레임의 와이어 텍스트 — 앱이 정확히 무엇을 받았는지 볼 수 있습니다;
- 주입된 프레임은 표시가 붙고, 트레이스 텍스트는 이스케이프됩니다(델타 안의 `</script>`가 패널을 벗어날 수 없음).

## 이 도구가 재현하는 실패

- 메시지 중간에 토큰이 드롭되거나 중복됨.
- 툴 인자가 JSON 중간에서 잘리거나, `tool-input-start`보다 먼저 도착함.
- `finish` 없이 닫히는 스트림(스피너가 영영 안 꺼지고 `aria-busy`가 멈춤).
- 부분 콘텐츠 뒤의 에러 프레임(UI가 부분 텍스트를 유지하는가?).
- 프레임 사이의 느린 간격(멈춘 "타이핑" 상태, 타임아웃).
- 프로토콜 드리프트: 같은 세션을 SSE, NDJSON, AG-UI로 각각 재생해 UI가 무엇을 하는지 비교.

## 호환성

| 됨 | 안 됨 |
|---|---|
| HTTP/1.1 스트리밍 응답 (SSE, NDJSON, JSON, text) | H2/H3 멀티플렉스 스트림 |
| AI SDK UI message stream, legacy data stream, AG-UI, 일반 JSON 델타 | protobuf/gRPC 또는 바이너리 프레임 |
| Node 20/22, HTTP 서버 뒤의 모든 프레임워크 | Node 서버가 없는 브라우저 전용 앱(스트림을 서빙하는 오리진에 `--target`을 지정) |
| Playwright (`page.route`가 있는 모든 버전) | Cypress 응답 픽스처 / Vitest fetch 픽스처 |

## 한계 (의도적으로, 문서화된)

- **`raw`는 정규화된 텍스트이지 바이트 단위까지 같은 값이 아닙니다.** SSE 프레임은 파싱된 필드에서 다시 직렬화되고 UTF-8만 다룹니다. 바이트 수준 충실도(청크 크기, 압축)는 보존하지 않습니다 — 이 도구는 스트림 *의미론*에 관한 것입니다.
- **알 수 없는 프로토콜 필드는 손대지 않은 프레임에서만 살아남습니다.** 주입되거나 잘린 프레임은 정규화된 이벤트에서 다시 인코딩되므로, 여기서 모델링하지 않은 프로토콜 특유의 여분 필드는 *그* 프레임에서 빠집니다.
- **타이밍은 근사값입니다.** `t_ms`는 프록시의 도착 시각에서 나오고, 재생은 프레임 사이에 잠들며 밀리초 미만의 지터를 재현할 수 없습니다. `speed`와 `maxDelayMs`는 의도적으로 타이밍을 바꿉니다.
- **드롭된 소켓은 실제 TCP 종료입니다.** 일부 클라이언트는 자동 재시도합니다. streamscope는 재시도나 재연결 로직을 시뮬레이션하지 않습니다.
- **메타의 요청/응답 본문은 4KB로 제한**되고, 프록시는 `accept-encoding`을 제거하므로 녹화 중 업스트림은 비압축으로 응답합니다.
- **패널은 스트림 상태의 공통분모**를 모델링합니다(텍스트, 툴 인자, 결과, 승인). 앱의 리듀서를 돌리지 않으므로 앱 특유의 파생 상태는 표시하지 않습니다.
- **보안 스캐너가 아닙니다.** 헤더 리댁션은 내장 자격 증명 목록만 다루고, 본문과 사용자 정의 헤더는 보낸 그대로 저장됩니다. 커밋하기 전에 검토하세요.

## 개발

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest: parsers, adapters, recorder, faults, replay, proxy, panel, CLI, fixture
npm run build         # tsup -> dist (index, playwright, cli)
npm run verify        # 위의 모든 것

npm run demo                        # 데모 앱 :8790
node scripts/record-demo.mjs        # 실제 프록시로 demo/traces/*.jsonl 다시 녹화
```

**로컬 E2E** (실제 Chromium): `npm run build && npm run test:e2e`. `demo/app.html`을 `replayStream()`을 통해 구동한 뒤, 연결 끊김 케이스와 패널을 확인합니다. Playwright 자체 브라우저가 설치돼 있지 않다면 `PLAYWRIGHT_CHROMIUM=/path/to/chromium`을 설정하세요. 최소한의 Linux 이미지에서는 번들 Chromium의 `libs/`와 시스템 `libnspr4`를 가리키는 `LD_LIBRARY_PATH`도 필요할 수 있습니다. CI의 `e2e` 잡은 `npx playwright install --with-deps chromium`으로 Chromium을 설치합니다.

## 로드맵

- `streamscope serve` — 한 프로세스에서 녹화 + 재생 (세션 목록 패널).
- 두 트레이스를 프레임 단위로 비교 (`streamscope diff a.jsonl b.jsonl`).
- 커밋되는 트레이스용 사용자 정의 헤더/본문 리댁션 규칙 (내장 자격 증명 마스크는 0.1.1부터 제공).

## 라이선스

MIT © jungingwon ([developjik](https://github.com/developjik))

## 테스트 러너 픽스처와 제공자 이벤트 (DEV-123)

패키지명은 `streamscope`를 유지합니다. 아래 export는 소스 빌드에서 제공하며 이번 PR은 npm을 배포하지 않습니다.

```ts
import { createTraceFetch, toMatchTrace } from 'streamscope/vitest';
import { interceptTrace } from 'streamscope/cypress';
expect.extend({ toMatchTrace });
vi.stubGlobal('fetch', createTraceFetch(trace, { url: '/api/chat' }));
expect(actualTrace).toMatchTrace(trace);
interceptTrace(cy, '/api/chat', trace);
```

Node에서는 readTrace로, 브라우저에서는 JSONL을 읽어 Trace를 전달하세요. 매칭되지 않은 fetch는 명시적으로 fallback을 주지 않으면 실패합니다. afterEach에서 vi.unstubAllGlobals로 원래 fetch를 복구하세요. streamscope/vitest를 가져오면 매처 타입도 확장됩니다. e2e/fixtures.browser.test.ts는 실제 Vitest browser-mode에서 녹화 파일의 일치와 불일치를 검증합니다.

createTraceFetch는 실제 Response/ReadableStream에 녹화된 프레임을 보내며 speed:1로 시간 간격, AbortSignal로 중단을 지원합니다. toMatchTrace는 정규화 이벤트를 순서대로 비교해 첫 불일치 프레임의 0부터 시작하는 번호를 알려줍니다. 시간과 와이어 포맷은 비교하지 않습니다. Cypress 응답은 버퍼링되므로 프레임별 시간·네트워크 단절 재현은 Playwright 재생 서버를 사용하세요.

OpenAI Assistants의 thread.run.*, thread.message.delta, 도구 인자 델타와 LangGraph SDK의 metadata, messages/messages-tuple, end, error SSE 이벤트를 정규화합니다. LangGraph의 values/updates 등 다른 모드는 기존 generic 처리입니다. 기존 SSE/NDJSON은 유지합니다. 외부 API를 호출하지 않고 녹화 JSONL과 Chromium에서 통과·실패를 재현합니다.

검증: npm run verify && npm run test:e2e && npm run test:browser

## 개발 기준선 (DEV-128)

개발과 CI는 Node.js 22.12.0(`.nvmrc`) 이상을 사용합니다. Vitest 5.1.1의 공식 지원 범위에는 Node 20.19가 없습니다. 실행이 된다는 이유로 공식 지원이라고 부르지 않습니다. 패키지 사용자의 기존 engines는 유지합니다. Node 20 지원 패키지는 테스트 러너 없이 빌드한 tarball의 운영 의존성만 설치하고 CLI/import를 별도로 검사합니다. 개발 TypeScript 기준은 7.0.2입니다.

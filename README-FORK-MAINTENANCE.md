# Fork 유지관리 가이드

이 문서는 `ropering/obsidian-copilot` fork에서 로컬 커스텀 기능을 관리하고, 원본 `logancyang/obsidian-copilot` 업데이트를 최대한 충돌 없이 반영하기 위한 운영 절차입니다.

## 1. 기본 원칙

- `master`는 원본 업데이트를 받는 기준 브랜치로 유지합니다.
- 커스텀 기능 개발은 `codex/*` 브랜치에서만 진행합니다.
- 루트 `README.md`처럼 원본에서 자주 바뀌는 문서는 가능한 한 수정하지 않습니다.
- Plus 라이선스 검증, Plus chain gate, Brevilabs API 경로는 우회하거나 수정하지 않습니다.
- Desktop Codex CLI 관련 기능은 별도 provider, 별도 chain runner, 별도 service 파일에 최대한 격리합니다.
- `.codex/` 아래 로컬 Codex 설정 파일은 저장소 기능 변경이 아니므로 커밋하지 않습니다.

## 2. Remote와 브랜치 구성

현재 fork remote는 `origin`으로 유지합니다.

```powershell
git remote -v
```

원본 저장소는 `upstream`으로 등록합니다.

```powershell
git remote add upstream https://github.com/logancyang/obsidian-copilot.git
git fetch upstream
```

이미 등록되어 있다면 URL만 확인합니다.

```powershell
git remote get-url upstream
```

커스텀 작업 브랜치는 다음처럼 만듭니다.

```powershell
git switch master
git switch -c codex/desktop-codex-cli-integration
```

## 3. 커밋 전략

기능을 한 커밋에 모두 몰아넣지 않습니다. 원본 업데이트와 충돌했을 때 어느 기능이 문제인지 추적할 수 있도록 의미 단위로 나눕니다.

권장 커밋 단위는 다음과 같습니다.

```text
docs: add project structure guide
feat: add desktop codex cli chat provider
fix: stabilize desktop codex cli selection and execution
feat: add desktop codex local tools mode
fix: pass desktop codex images as cli attachments
docs: add fork maintenance guide
```

커밋 전에는 항상 staged diff를 확인합니다.

```powershell
git diff --cached --stat
git diff --cached
```

특히 `.codex/`, 개인 vault 경로, 임시 파일, 빌드 산출물이 섞이지 않았는지 확인합니다.

## 4. 빌드 방법

의존성이 없거나 오래된 경우 먼저 설치합니다.

```powershell
npm install
```

프로덕션 빌드는 다음 명령을 사용합니다.

```powershell
npm run build
```

이 저장소에서는 자동화 작업 중 `npm run dev`를 실행하지 않습니다. watch 모드는 사용자가 직접 필요할 때만 실행합니다.

## 5. Obsidian에 적용하는 방법

빌드가 성공하면 다음 파일을 테스트 vault의 플러그인 디렉터리에 복사합니다.

```text
main.js
manifest.json
styles.css
```

예시 경로:

```text
C:\mnt\google_drive\Obsidian Vault\250216_vault\.obsidian\plugins\copilot
```

적용 절차:

1. Obsidian을 종료하거나 Community plugins에서 Copilot을 비활성화합니다.
2. 빌드 산출물 3개를 vault의 `.obsidian/plugins/copilot/`에 덮어씁니다.
3. Obsidian을 다시 열거나 Copilot 플러그인을 재활성화합니다.
4. Settings에서 `Desktop Codex CLI Chat` 모델이 보이고 선택 가능한지 확인합니다.
5. `Local Services > Local Web Search`에서 `@websearch` provider를 설정합니다.
   - 무료/self-host 방식: SearXNG URL을 입력합니다.
   - 외부 API 방식: Firecrawl, Perplexity, Tavily provider를 선택하고 본인 API key를 입력합니다.
   - Tavily는 기본 `Search Depth=basic`, `Max Results=5`이며 설정 화면에서 변경할 수 있습니다.
6. 일반 Chat, Vault QA, `codex tools (local)`을 각각 짧게 테스트합니다.

## 6. Desktop Codex CLI 기능 사용법

### 6.1 사전 조건

- Desktop Obsidian에서만 사용합니다. 모바일 Obsidian은 지원하지 않습니다.
- 로컬 환경에 Codex CLI가 설치되어 있고 로그인되어 있어야 합니다.
- Obsidian이 Codex CLI binary를 찾을 수 있어야 합니다. 탐색 순서는 `CODEX_CLI_BINARY`, `CODEX_CLI_PATH`, Windows native fallback, `codex`입니다.
- `Desktop Codex CLI Chat` 모델은 별도 LLM API key를 요구하지 않습니다. Codex CLI의 로컬 설정과 로그인 상태를 사용합니다.

### 6.2 `Desktop Codex CLI Chat` 모델

`Desktop Codex CLI Chat`은 Obsidian Copilot의 일반 chat model로 노출되는 로컬 Codex CLI provider입니다.

동작 방식:

- Obsidian/LangChain 메시지를 Codex CLI용 transcript prompt로 변환합니다.
- `codex exec`를 vault root에서 `read-only`, `ephemeral` 방식으로 실행합니다.
- `--model`, `--profile`은 넘기지 않고 사용자의 Codex CLI 기본 설정을 따릅니다.
- 응답은 token 단위 streaming이 아니라 Codex CLI 실행이 끝난 뒤 최종 답변을 한 번에 표시합니다.
- 이미지 첨부는 base64를 prompt에 넣지 않고 temp image file로 저장한 뒤 `--image <file>`로 전달합니다.

권장 사용처:

- 일반 Chat에서 로컬 Codex CLI를 LLM backend로 사용
- Vault QA에서 긴 RAG context를 Codex CLI로 질의
- 이미지 1개 또는 여러 개를 첨부한 질문

질문 예시:

```text
이 vault의 맥락 없이, Desktop Codex CLI Chat이 정상 작동하는지 짧게 답변해줘.
```

```text
첨부한 이미지 2개를 비교해서 차이점을 표로 정리해줘.
```

Vault QA 예시:

```text
내 vault에서 최근 정리한 Codex CLI 관련 내용을 찾아 핵심 결정사항과 남은 작업을 요약해줘.
```

### 6.3 `codex tools (local)` 모드

`codex tools (local)`은 Copilot Plus 라이선스나 Brevilabs gateway를 사용하지 않는 별도 local tools mode입니다. 현재 선택된 chat model이 반드시 `Desktop Codex CLI Chat`이어야 합니다.

동작 방식:

- 사용자가 명시한 `@` 도구만 Codex CLI 호출 전에 사전 실행합니다.
- 실행된 tool 결과를 `# Additional context:` 아래에 배치하고, 실제 사용자 질문은 마지막 `[User query]:` 아래에 둡니다.
- `@websearch` 결과가 있으면 기존 citation utility를 사용해 web citation instruction을 추가합니다.
- native tool calling, autonomous agent loop, Copilot Plus runner 직접 호출은 사용하지 않습니다.

지원 도구:

- `@vault`: 기존 local vault search tool을 실행하고 결과를 Codex CLI context로 전달합니다.
- `@websearch` 또는 `@web`: `Local Services > Local Web Search` 설정을 사용합니다. Copilot Plus/Brevilabs는 호출하지 않습니다.
- `@composer`: Codex가 제안한 `writeFile`/`editFile` XML block을 기존 composer preview tool로 처리합니다.
- `@memory`: Saved Memory가 켜져 있을 때 memory tool을 실행합니다.

설정 절차:

1. Chat model을 `Desktop Codex CLI Chat`으로 선택합니다.
2. 기능 선택 목록에서 `codex tools (local)`을 선택합니다.
3. 웹 검색을 쓰려면 `Local Services > Local Web Search`에서 provider를 설정합니다.
   - SearXNG: local/self-host endpoint 필요, API key 없음
   - Firecrawl/Perplexity/Tavily: 사용자 API key 필요
   - Tavily: `Search Depth`와 `Max Results`를 설정 화면에서 조정 가능
4. 출처 footnote 표시를 원하면 `QA Settings > Enable Inline Citations (experimental)`을 켭니다.

질문 예시:

```text
@vault 내 노트에서 Desktop Codex CLI와 관련된 내용을 찾아서 현재 구현 상태와 리스크를 정리해줘.
```

```text
@websearch 최근 Obsidian AI 플러그인 동향을 찾아서 핵심 변화와 참고 출처를 함께 요약해줘.
```

```text
@vault @websearch 내 노트에 정리된 Copilot 커스텀 방향과 최근 웹 검색 결과를 비교해서 다음 개발 우선순위를 제안해줘.
```

```text
@composer README-FORK-MAINTENANCE.md에 Local Codex 수동 테스트 항목을 짧게 추가하는 변경안을 만들어줘.
```

```text
@memory 앞으로 이 프로젝트에서는 upstream 충돌을 줄이기 위해 기존 공용 utility를 먼저 찾는 원칙을 기억해줘.
```

문제 확인 예시:

- `@websearch`에서 "local web search is not configured"가 나오면 `Local Services > Local Web Search` provider, endpoint, API key를 확인합니다.
- `codex tools (local) requires the selected chat model...` 오류가 나오면 chat model이 `Desktop Codex CLI Chat`인지 확인합니다.
- 응답이 늦게 보이는 것은 token streaming이 아니라 Codex CLI 완료 후 단일 chunk로 표시되는 현재 v1 동작입니다.

### 6.4 `codex projects (local)` 모드

`codex projects (local)`은 Copilot Plus의 Projects UX와 Project 설정을 재사용하되, Plus license gate나 Brevilabs 변환 API를 사용하지 않는 Desktop Codex CLI 전용 local project mode입니다.

동작 방식:

- Project 목록, Project별 system prompt, Project별 model 설정을 기존 UI에서 그대로 사용합니다.
- Project context는 local loader가 매 요청 시 구성하고 `<ProjectContext>` 형태로 Codex CLI prompt에 전달합니다.
- 지원 파일은 `md`, `base`, `canvas`입니다.
- Project Web URL 목록은 `Local Services > Local Web Search` provider로 검색/요약하여 Web Content context로 전달합니다.
- PDF, DOCX, PPTX, YouTube, Twitter/X, Brevilabs `docs4llm/url4llm/youtube4llm/twitter4llm` 경로는 호출하지 않습니다.
- 미지원 항목은 progress/status에 `local mode unsupported`로 표시합니다.

설정 절차:

1. Project의 model을 `Desktop Codex CLI Chat`으로 선택합니다.
2. 기능 선택 목록에서 `codex projects (local)`을 선택합니다.
3. 기존 Projects 화면에서 Project를 생성하거나 선택합니다.
4. Project context에는 Markdown/base/canvas 파일 패턴과 Web URL 목록만 넣는 것을 권장합니다.
5. Web URL context를 쓰려면 `Local Services > Local Web Search`에서 Tavily 등 provider와 API key를 설정합니다.

질문 예시:

```text
이 프로젝트 context를 기준으로 현재 설계의 핵심 결정사항과 미해결 리스크를 정리해줘.
```

```text
@vault 이 프로젝트와 관련된 vault 내용을 추가로 찾아서 Project context와 함께 비교해줘.
```

```text
Project Web URL context와 내 Markdown 노트의 내용을 종합해서 다음 구현 순서를 제안해줘.
```

주의점:

- 이 모드는 Plus Projects의 local-compatible subset입니다. 문서 변환, YouTube transcript, Twitter/X 변환은 Plus와 동일하게 동작하지 않습니다.
- Project context가 큰 경우 Codex CLI 응답이 늦게 표시될 수 있습니다.
- Plus Projects와 혼동하지 않도록 Brevilabs fallback을 추가하지 않습니다.

## 7. 원본 업데이트 반영 방법

작업 브랜치가 깨끗한 상태인지 먼저 확인합니다.

```powershell
git status
```

원본 업데이트를 가져옵니다.

```powershell
git fetch upstream
```

`master`를 원본 기준으로 fast-forward 합니다.

```powershell
git switch master
git merge --ff-only upstream/master
```

커스텀 브랜치를 최신 `master` 위로 재배치합니다.

```powershell
git switch codex/desktop-codex-cli-integration
git rebase master
```

충돌이 나면 파일군별로 나눠 확인합니다.

- Codex provider: `src/services/codexCli/`, `src/LLMProviders/CodexCliChatModel.ts`
- Chain runner: `src/LLMProviders/chainRunner/DesktopCodexCliToolsChainRunner.ts`
- Provider/settings 등록: `src/constants.ts`, `src/aiParams.ts`, `src/settings/model.ts`, `src/LLMProviders/chatModelManager.ts`
- UI 노출: `src/components/chat-components/`, `src/settings/v2/components/`
- 유틸/게이트: `src/utils.ts`, `src/chainFactory.ts`

충돌 해결 후에는 다음 순서로 계속합니다.

```powershell
git add <resolved-files>
git rebase --continue
```

rebase가 끝난 뒤 반드시 테스트를 다시 실행합니다.

## 8. 검증 체크리스트

Codex 관련 변경 후 최소 검증:

```powershell
npx jest src/services/codexCli/CodexCliClient.test.ts src/services/codexCli/CodexCliImageAttachments.test.ts src/LLMProviders/CodexCliChatModel.test.ts src/LLMProviders/chainRunner/DesktopCodexCliToolsChainRunner.test.ts src/utils.test.ts --runInBand
npm run lint
npm run build
```

수동 검증:

- `codex --version`이 Obsidian desktop runtime에서도 인식되는지 확인합니다.
- `Desktop Codex CLI Chat` 모델이 disabled 없이 선택되는지 확인합니다.
- 짧은 일반 질문이 pending 없이 완료되는지 확인합니다.
- Vault QA에서 긴 검색 컨텍스트가 `ENAMETOOLONG` 없이 처리되는지 확인합니다.
- 이미지 1개와 2개 이상 첨부 질문이 `input_too_large` 없이 처리되는지 확인합니다.
- `codex tools (local)`에서 `@vault`, `@composer`, `@memory` 동작을 확인합니다.
- `codex tools (local)`에서 `@websearch`가 Local Web Search provider를 통해 동작하는지 확인합니다.
- `codex projects (local)`에서 Markdown/base/canvas Project context가 Codex CLI 답변에 반영되는지 확인합니다.
- `codex projects (local)`에서 PDF/DOCX/YouTube 항목이 Brevilabs fallback 없이 `local mode unsupported`로 표시되는지 확인합니다.
- Plus 라이선스가 없는 상태에서 Plus-only 기능은 기존처럼 차단되는지 확인합니다.

## 9. 주의점

- 원본 라이선스는 AGPL-3.0입니다. public fork와 수정본 배포는 가능하지만, 수정본 전체를 AGPL-3.0 조건으로 유지해야 합니다.
- 원본의 copyright, license, no warranty 고지를 제거하지 않습니다.
- 수정한 사실과 변경 이력을 커밋/문서/릴리스 노트 등으로 명확히 남깁니다.
- `main.js` 같은 빌드 산출물을 배포할 때는 같은 버전의 대응 소스도 GitHub branch/tag로 접근 가능해야 합니다.
- 네트워크 서비스 형태로 수정본을 운영하는 경우에도 사용자가 대응 소스를 받을 수 있어야 합니다.
- 외부 코드, 이미지, 아이콘, 문서를 추가할 때는 AGPL-3.0과 충돌하지 않는 권한인지 확인합니다.
- Desktop Codex CLI 기능은 desktop Obsidian 전용입니다. 모바일 Obsidian 지원을 가정하지 않습니다.
- 새 기능을 추가할 때는 기존 공용 utility를 먼저 찾고, 동일한 포맷/검증/후처리 로직이 있으면 복제 구현보다 참조를 우선합니다.
- 단, 공용화를 위해 upstream hot file을 직접 추출/리팩터해야 한다면 충돌 위험을 먼저 평가하고, 가능하면 커스텀 adapter 파일에서 얇게 참조합니다.
- Desktop Codex CLI prompt는 공통 system prompt, `codex tools (local)` 전용 instruction, Codex CLI transport wrapper 순서로 구성됩니다.
- `codex tools (local)` instruction은 Plus prompt의 source/citation integrity 원칙만 local pre-executed tool 방식에 맞춰 반영하며, Plus runner를 직접 호출하지 않습니다.
- Local Codex tool result formatting은 `renderCiCMessage`, `injectGuidanceBeforeUserQuery`, citation utility 같은 기존 공용 helper를 우선 사용합니다.
- Local Codex `@websearch`는 Copilot Plus/Brevilabs를 호출하지 않습니다. 별도 Local Web Search 설정만 사용합니다.
- Local Codex Projects는 Markdown/base/canvas와 Local Web Search 기반 Web URL만 지원합니다.
- Local Codex Projects에서 PDF/DOCX/PPTX/YouTube/Twitter/X를 Brevilabs로 fallback하지 않습니다.
- SearXNG는 API key가 필요 없지만 사용자가 직접 로컬 또는 self-host endpoint를 준비해야 합니다.
- Firecrawl/Perplexity/Tavily Local Web Search는 사용자의 별도 API key가 필요하며 Plus license key와 무관합니다.
- Tavily Local Web Search는 `Search Depth`와 `Max Results`만 사용자 설정으로 열고, `include_answer=false`, `include_images=false`를 유지합니다.
- Codex CLI binary는 `CODEX_CLI_BINARY`, `CODEX_CLI_PATH`, Windows native fallback, `codex` 순서로 찾습니다.
- 프롬프트는 stdin으로 전달합니다. 긴 RAG 컨텍스트를 argv로 넘기면 Windows에서 `ENAMETOOLONG`이 발생할 수 있습니다.
- 이미지 첨부는 base64를 프롬프트에 넣지 않고 temp file과 `--image`로 전달해야 합니다.
- temp file은 성공, 실패, timeout, abort 모두에서 정리되어야 합니다.
- `--model`, `--profile`은 넘기지 않고 사용자의 Codex CLI 기본 설정을 따릅니다.
- upstream rebase 후 settings migration, built-in model 병합, model selector disabled 상태를 반드시 확인합니다.
- 원본이 같은 파일을 크게 바꾼 경우, 커스텀 코드를 새 파일로 다시 격리할 수 있는지 먼저 검토합니다.

## 10. Push 절차

검증이 끝나면 feature branch를 fork remote로 push합니다.

```powershell
git push -u origin codex/desktop-codex-cli-integration
```

이후 같은 브랜치에 추가 커밋을 올릴 때는 다음만 사용합니다.

```powershell
git push
```

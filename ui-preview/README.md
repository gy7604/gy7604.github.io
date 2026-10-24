# 교대근무 기존 달력 · 조별 가로형 카드 UI 테스트

기준일: 2026-10-24

## 추천 테스트 페이지

- [새 시안: 조별 가로형 카드 / 월간 7열 달력 유지](https://raw.githack.com/gy7604/gy7604.github.io/shift-ui-preview-20261024/ui-preview/team-separated.html)
- 기본 `ui-preview/index.html`도 동일한 새 시안으로 교체

**이번 작업에서 바뀐 것은 날짜별 A·B·C·D조의 시각적 구분뿐입니다.**
월간 근무 달력의 7열 배치, 한 날짜 안의 조 순서, 휴무 신청 칸, 대근 칸, 다중 신청 행 및 메모의 기존 위치를 유지했습니다.

조 하나에 신청자가 여럿이면 여러 행을 **같은 조 카드 하나의 일부분**으로 나타내며, 조와 조 사이에는 여백을 둡니다. 각 조는 A 파랑 / B 녹색 / C 주황 / D 보라색 왼쪽 테두리로 구분합니다. **별도의 날짜 선택, 주간 모드, 전체화면 조별 상세 뷰를 추가하지 않습니다.**

가상 근무 데이터로 화면을 시연하는 별도 브랜치의 정적 HTML입니다. 테스트용 밀집 주간에는 A조 4행, B조 3행, C조 3행, D조 2행으로 늘어나지만 원래 앱의 주별 행 정렬 개념은 같습니다.

## 실제 서버 연동형 코드(운영 미게시)

- 별도 브랜치: `feature/shift-live-readonly-preview-20261024`
- 파일: `ui-preview/team-separated-live.html`
- 원래 앱의 `calendar.js` 렌더러, 상단 사용자 이름, 날짜/월 이동, 휴무·대근·메모 UI 코드 기반
- `login`, `calendar_read`, `personal_read` 이외 서버 액션 전면 차단; 변경은 브라우저 메모리에서만 시연
- 개인별 로그인 데이터를 공개 HTML에 복사하지 않음
- 서버 보안 정책에 따라 실제 로그인은 `https://gy7604.github.io/ui-preview/team-separated-live.html` 에서만 가능
- **해당 파일을 운영 브랜치에 게시하는 작업은 미실행. 사용자의 별도 승인 필요**

## 안전 사항

기존 `main/index.html`, `main/assets/calendar.js`, `main/assets/calendar.css`, `main/service-worker.js`, Supabase 기록, 푸시 구독 및 다른 앱은 변경하지 않았습니다.

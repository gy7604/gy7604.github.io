# 교대근무 UI/UX 월간 카드형 디자인 미리보기

2026-10-24 버전. 운영 앱은 변경하지 않았습니다.

## 지금 볼 테스트 페이지
https://raw.githack.com/gy7604/gy7604.github.io/shift-ui-preview-20261024/ui-preview/month-cards.html

- 월간 달력(7열)에서 날짜 선택 -> A/B/C/D조 개별 카드 4개 표시
- 주간 전용 달력·주간 보기 전환 제거
- 조별 색·근무 유형(주간/야간/휴무)·휴무 신청·대근 정보
- 모바일 1열 / PC 2열 카드 배치
- 이전/다음 달, 오늘, 월 선택, 이전/다음 날
- 휴무·대근 화면 시연 변경은 브라우저 메모리에만 존재
- 로그인, Supabase, 푸시, 기상알람에 접근하지 않는 **가상 데이터 디자인 판**
- `ui-preview/index.html`도 같은 카드형 디자인으로 갱신

## 실제 서버 조회용 별도 시연 코드

`feature/shift-live-readonly-preview-20261024` 브랜치의 `ui-preview/live-cards.html` 파일을 준비했습니다.

- 진짜 근무/휴무/대근/메모 자료는 **본인 로그인 후** 기존 `app-session`의 `calendar_read` API로 조회
- 서버에서 쓰기 요청을 하지 않는 화이트리스트(`login`, `calendar_read`, `personal_read`)
- 휴무·대근·메모의 시연 변경은 해당 브라우저 메모리에서만 수행
- 로그인 토큰은 메모리에만 보관
- 타 도메인에서의 로그인 차단: `https://gy7604.github.io/ui-preview/live-cards.html` 주소에서만 작동
- **현재는 브랜치에만 저장**. `main` 배포 없이 위 주소가 열리지 않음. 추가 파일 하나의 GitHub Pages 게시에 대한 별도 승인 필요
- 실제 로그인/원격 API 종단 간 검증은 미실시

## 보존

정식 `index.html`, `assets/calendar.js`, `assets/calendar.css`, `service-worker.js`와 기존 Supabase 데이터·구독은 수정하지 않았습니다.

이전 구조 유지형 테스트: `ui-preview/classic.html` (참고용이며 권장하지 않음).

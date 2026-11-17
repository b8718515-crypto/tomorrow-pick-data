# 내일뭐하지? 축제 정보

토스 미니앱 「내일뭐하지?」가 읽는 전국 축제·공연·행사 정보예요.

- 출처: 한국관광공사 TourAPI(국문 관광정보 서비스), 공공누리 조건에 따라 출처를 표시해요.
- 갱신: 매일 한국 시간 00:00 · 09:00 · 12:00 · 17:00 (GitHub Actions 예약 실행, 몇 분 늦어질 수 있음)
- 공개 주소: `https://<계정>.github.io/<저장소>/festivals.json`

## 구성

| 파일 | 하는 일 |
|---|---|
| `scripts/fetch-festivals.mjs` | TourAPI에서 목록·자세한 정보·추가 사진을 모아 `festivals.json` 을 만든다 |
| `data/festival-details.json` | 이미 받은 자세한 정보(다시 부르지 않게 저장) |
| `data/tourapi-usage.json` | 오늘(한국 시간) 쓴 호출 수 — 기능별 하루 900번을 넘기지 않는다 |
| `.github/workflows/collect.yml` | 하루 4번 실행 예약 |

## 키 넣기

TourAPI 키는 저장소 **Settings → Secrets and variables → Actions** 의 `TOURAPI_KEY` 에만 넣어요. 파일에 적지 않아요.

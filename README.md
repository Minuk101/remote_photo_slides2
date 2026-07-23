# Remote Photo Slides 2

집 PC의 사진 폴더를 같은 Wi-Fi의 PC·태블릿에서 선택하고 랜덤 슬라이드쇼로 재생합니다. 기존 버전과 달리 사진 한 장의 좌표만 보지 않고 Google 타임라인과 GPSLogger의 앞뒤 이동 기록을 방문 단위로 분석해 장소를 표시합니다.

## 주요 기능

- 선택한 폴더와 모든 하위 폴더의 JPG 자동 반영
- 모든 접속 기기에 동일한 폴더 선택 공유
- 완전 무작위 순서와 새 사진 즉시 합류
- 다음 사진 프리페치 및 PC 재생용 이미지 캐시
- 두 장의 표시 레이어만 유지해 브라우저 메모리 누적 방지
- GPSLogger 위성 위치 → GPSLogger 네트워크 위치 → Google 타임라인 순으로 보완
- 촬영 시각 앞뒤 위치를 보간하고 인접 사진을 방문 단위로 묶어 장소 결정
- 교정된 사진 GPS는 타임라인보다 우선
- 사진 원본과 EXIF는 수정하지 않음

## 기본 경로

- 사진 루트: `D:\민욱\사진`
- Google 타임라인: `D:\민욱\타임라인\google_maps\260723\timeline_export_1784779939485.gpx`
- GPSLogger: `D:\민욱\타임라인\GPSLogger`
- 기존 폴더 선택 설정: `D:\민욱\remote_slides\data\settings.json`
- 주소: `http://localhost:8081`

## 실행

`start.bat`을 실행합니다. 처음 한 번은 사진 촬영 시각을 읽고 이동 기록과 맞추므로 시간이 걸립니다. 이후 분석 결과와 재생 이미지는 로컬 캐시에 저장됩니다.

다른 기기에서는 PC의 내부 IP 주소에 `:8081`을 붙여 접속합니다.

```text
http://192.168.x.x:8081
```

경로와 포트는 환경 변수 `PHOTO_ROOT`, `PHOTO_ROOTS`, `GPX_PATH`, `GPSLOGGER_DIR`, `PORT`로 변경할 수 있습니다.

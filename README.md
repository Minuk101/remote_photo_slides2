# Timeline Visit Analyzer

사진 한 장의 GPS 좌표만으로 장소를 고르지 않고, GPX 타임라인의 이동 흐름과 체류 구간을 이용해 방문 단위 대표 장소를 추정하는 실험 프로젝트입니다.

## 원칙

- 사진 원본과 EXIF를 수정하지 않음
- 사진 자체 GPS가 있으면 타임라인과 비교
- GPS가 없으면 촬영 시각의 GPX 앞뒤 흐름으로 위치 추정
- 시간과 이동 경로가 이어지는 사진을 하나의 방문으로 묶음
- Google 장소 검색은 사진마다 하지 않고 방문마다 한 번 수행
- 기존 슬라이드쇼 태그와 새 방문 태그를 나란히 비교
- 수동으로 교정된 GPS가 과거 타임라인 보고서와 다르면 교정값을 우선

## 기본 경로

- 사진: `D:\민욱\사진\2025`, `D:\민욱\사진\2026`
- Google 타임라인 GPX: `D:\민욱\타임라인\google_maps\260723\timeline_export_1784779939485.gpx`
- GPSLogger 일별 기록: `D:\민욱\타임라인\GPSLogger`
- 기존 위치 캐시: `D:\민욱\remote_slides\data\locations\photo-locations.json`
- 서버: `http://localhost:8081`

## 실행

```powershell
npm install
npm start
```

첫 분석은 사진 메타데이터를 읽기 때문에 시간이 걸립니다. 이후 결과는 `data` 폴더에 저장되어 빠르게 열립니다.

환경 변수로 경로를 변경할 수 있습니다.

```powershell
$env:PHOTO_ROOTS='D:\사진\2025|D:\사진\2026'
$env:GPX_PATH='D:\타임라인\timeline.gpx'
$env:GPSLOGGER_DIR='D:\타임라인\GPSLogger'
$env:PORT='8081'
npm start
```

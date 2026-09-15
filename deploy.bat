@echo off
REM ============================================================================
REM tsconfig/ (wms nutrition module) — backend-only Cloud Run deployment.
REM Builds Dockerfile-node (no frontend), pushes to Artifact Registry, deploys.
REM
REM SERVICE_NAME defaults to a NEW service, NOT the live "fooddr" one, on
REM purpose: this checkout only implements the 22 nutrition-client routes
REM (missing /today, /profile, /coach, /meals, /achievements, etc.) and has
REM no working login (auth.moduleToken is an honest 501 stub) — pointing
REM this at the live "fooddr" service would replace production and break
REM every other route + all logins. Change SERVICE_NAME below only if you
REM have deliberately decided to accept that.
REM ============================================================================

cd /d "%~dp0"

set PROJECT_ID=legel-assistent-466812
set REPOSITORY_NAME=bizzzup
set REGION=asia-south1
set IMAGE_NAME=fooddr-nutrition-module
set IMAGE_TAG=v1
set SERVICE_NAME=fooddr-nutrition-module

echo Authenticating with Google Cloud...
call gcloud auth configure-docker %REGION%-docker.pkg.dev --quiet
if errorlevel 1 exit /b %errorlevel%
call gcloud config set project %PROJECT_ID%
if errorlevel 1 exit /b %errorlevel%

echo Building Docker image...
docker build --no-cache -f Dockerfile-node -t %IMAGE_NAME%:%IMAGE_TAG% .
if errorlevel 1 exit /b %errorlevel%

docker tag %IMAGE_NAME%:%IMAGE_TAG% %REGION%-docker.pkg.dev/%PROJECT_ID%/%REPOSITORY_NAME%/%IMAGE_NAME%:%IMAGE_TAG%
if errorlevel 1 exit /b %errorlevel%

echo Pushing image to Artifact Registry...
docker push %REGION%-docker.pkg.dev/%PROJECT_ID%/%REPOSITORY_NAME%/%IMAGE_NAME%:%IMAGE_TAG%
if errorlevel 1 exit /b %errorlevel%

echo Deploying to Cloud Run...
call gcloud run deploy %SERVICE_NAME% ^
  --image %REGION%-docker.pkg.dev/%PROJECT_ID%/%REPOSITORY_NAME%/%IMAGE_NAME%:%IMAGE_TAG% ^
  --platform managed ^
  --region %REGION% ^
  --allow-unauthenticated ^
  --timeout=120s ^
  --min-instances=0 ^
  --max-instances=10 ^
  --memory=1Gi ^
  --cpu=1 ^
  --port=8080 ^
  --cpu-boost ^
  --set-env-vars="MSSQL_HOST=13.234.94.212,MSSQL_PORT=1433,MSSQL_DATABASE=nutrition_sandbox,MSSQL_USER=nutrition_user,MSSQL_SCHEMA=fooddr,MSSQL_ENCRYPT=true,MSSQL_TRUST_SERVER_CERT=true,DEBUG=true"
if errorlevel 1 exit /b %errorlevel%

echo.
echo Deployment complete!
echo   gcloud run services describe %SERVICE_NAME% --region %REGION% --format="value(status.url)"
echo.
echo NOTE: MSSQL_PASSWORD, JWT_SECRET_KEY, CRYPTO_PAYLOAD_SECRET_KEY etc. are
echo NOT in --set-env-vars above (secrets shouldn't sit in this script) —
echo set them via `gcloud run services update %SERVICE_NAME% --set-env-vars=...`
echo or a secret-backed env file before this is usable.

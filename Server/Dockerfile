FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --no-create-home dsh
COPY app.py gunicorn.conf.py ./
USER dsh
EXPOSE 8787
CMD ["gunicorn", "--config", "gunicorn.conf.py", "app:app"]

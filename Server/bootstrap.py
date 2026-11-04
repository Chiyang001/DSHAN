"""Small helpers invoked by start.bat; keeps parentheses out of batch parsing."""
import sys


def main():
    if len(sys.argv) < 2:
        sys.exit(2)
    command = sys.argv[1]
    if command == "version":
        print(sys.version.split()[0])
        return
    if command == "require-39":
        sys.exit(0 if sys.version_info[:2] >= (3, 9) else 1)
    if command == "executable":
        print(sys.executable)
        return
    if command == "deps":
        import flask  # noqa: F401
        import flask_sock  # noqa: F401
        import simple_websocket  # noqa: F401
        return
    sys.exit(2)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        sys.exit(1)

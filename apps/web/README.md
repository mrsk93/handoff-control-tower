# Operator console

The M9 operator console is the framework-light browser surface in `src/operator-console.ts`.
The API serves the same synthetic console at `/` for local demonstration; it reads only the
tenant-scoped operator routes and never connects to PostgreSQL directly.

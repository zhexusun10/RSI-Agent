#!/usr/bin/env node
// Bounded push-CI entry point. It is the same validation command used on a real
// Docker host. Pass --suite target, --suite entrypoint, or --suite all. It does
// not run or claim the optional 24-hour soak.
import "./linux-validation.mjs";

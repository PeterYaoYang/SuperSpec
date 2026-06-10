#!/usr/bin/env node
import { runEntry } from "./launch.js";

await runEntry("../dist/superspec_guard.js", "main");

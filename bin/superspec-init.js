#!/usr/bin/env node
import { runEntry } from "./launch.js";

await runEntry("../dist/superspec_init.js", "main_init_async");

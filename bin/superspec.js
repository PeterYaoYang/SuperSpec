#!/usr/bin/env node
import { runEntry } from "./launch.js";

await runEntry("../dist/superspec.js", "main_superspec");

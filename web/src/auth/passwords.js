import bcrypt from "bcrypt";
import { config } from "../config.js";

export function hash(password) {
  return bcrypt.hash(password, config.bcryptRounds);
}
export function verify(password, hashStr) {
  return bcrypt.compare(password, hashStr);
}

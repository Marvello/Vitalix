import bcrypt from "bcrypt";
import { config } from "../config.js";

export const DUMMY_HASH = bcrypt.hashSync("vitalix-dummy-password", config.bcryptRounds);

export function hash(password) {
  return bcrypt.hash(password, config.bcryptRounds);
}
export function verify(password, hashStr) {
  return bcrypt.compare(password, hashStr);
}

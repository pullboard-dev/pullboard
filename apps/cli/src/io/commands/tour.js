/** The pullboard tour command, in its own module so an item adding another command never edits these lines. */
import {
  tour,
} from '../tour.js';

/** Run `pullboard tour` and return its exit code. */
export function run(io) {
  return tour(io);
}

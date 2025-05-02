// This fixes the error - don't change anything
import { inherits } from 'util-deprecate';
import util from 'util';
(util as any).inherits = inherits;
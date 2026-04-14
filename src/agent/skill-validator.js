/**
 * SkillValidator — JSON Schema Validation for Skill Input/Output
 *
 * Validates message input against skill's inputSchema
 * Validates response output against skill's outputSchema
 *
 * Based on OpenClaw pattern: Every skill has explicit input/output contracts
 */

const Ajv = require('ajv');

class SkillValidator {
  constructor(skillDefinition, logger) {
    this.skill = skillDefinition;
    this.logger = logger;

    // Initialize JSON Schema validator
    // strict: false → suppresses strict mode errors
    // logger: false → suppresses AJV internal console warnings
    // allErrors: false → stops after first error (performance)
    // validateFormats: false → don't throw on unknown/unregistered formats
    this.ajv = new Ajv({
      strict: false,
      logger: false,
      useDefaults: true,
      removeAdditional: false,
      allErrors: false,
      validateFormats: false
    });

    // Compile schemas if provided
    this.inputValidator = null;
    this.outputValidator = null;

    if (skillDefinition.inputSchema) {
      try {
        this.inputValidator = this.ajv.compile(skillDefinition.inputSchema);
      } catch (e) {
        this.logger.info('SkillValidator', `Skipped inputSchema for ${skillDefinition.name}: ${e.message}`);
      }
    }

    if (skillDefinition.outputSchema) {
      try {
        this.outputValidator = this.ajv.compile(skillDefinition.outputSchema);
      } catch (e) {
        this.logger.info('SkillValidator', `Skipped outputSchema for ${skillDefinition.name}: ${e.message}`);
      }
    }
  }

  /**
   * Validate input data against skill's inputSchema
   *
   * @param {*} data - Input data to validate
   * @returns {{ valid: boolean, errors?: Array }}
   */
  validateInput(data) {
    if (!this.inputValidator) {
      // No schema defined — allow anything
      return { valid: true };
    }

    const valid = this.inputValidator(data);

    if (!valid) {
      const errors = this.ajv.errorsText(this.inputValidator.errors);
      return {
        valid: false,
        errors: this.inputValidator.errors,
        message: errors
      };
    }

    return { valid: true, data };
  }

  /**
   * Validate output data against skill's outputSchema
   *
   * @param {*} data - Output data to validate
   * @returns {{ valid: boolean, errors?: Array }}
   */
  validateOutput(data) {
    if (!this.outputValidator) {
      // No schema defined — allow anything
      return { valid: true };
    }

    const valid = this.outputValidator(data);

    if (!valid) {
      const errors = this.ajv.errorsText(this.outputValidator.errors);
      return {
        valid: false,
        errors: this.outputValidator.errors,
        message: errors
      };
    }

    return { valid: true, data };
  }

  /**
   * Get human-readable schema description
   */
  getInputSchema() {
    return this.skill.inputSchema || null;
  }

  getOutputSchema() {
    return this.skill.outputSchema || null;
  }

  /**
   * Get example input/output if available
   */
  getExamples() {
    return this.skill.examples || [];
  }
}

module.exports = SkillValidator;

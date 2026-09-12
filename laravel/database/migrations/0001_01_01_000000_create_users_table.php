<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Employees are the users of this system — there is no separate "user" that an
 * employee belongs to, which is how the Node app it replaces worked too. So the
 * auth table is `employees`, and Laravel's session/password-reset tables hang
 * off it.
 *
 * Pay is stored in integer cents. Everywhere money appears it is cents, never a
 * float, so nothing can drift by a rounding error on the way through a payroll
 * export.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('employees', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('first_name')->nullable();
            $table->string('last_name')->nullable();
            $table->string('initials', 8)->nullable();

            // Nullable + unique: older records may have no login at all, and
            // those must not collide with each other on an empty value.
            $table->string('email')->nullable()->unique();
            $table->string('password')->nullable();
            $table->rememberToken();

            $table->string('phone')->nullable();
            $table->string('address1')->nullable();
            $table->string('address2')->nullable();
            $table->string('city')->nullable();
            $table->string('province')->nullable();
            $table->string('postal', 16)->nullable();
            $table->string('country')->nullable();
            $table->date('birth_date')->nullable();

            $table->string('employment_type')->nullable();
            $table->string('job_title')->nullable();
            $table->decimal('vacation_weeks', 4, 2)->nullable();
            $table->date('start_date')->nullable();
            $table->date('termination_date')->nullable();

            // 'hourly' => pay_rate_cents is cents per hour.
            // 'salary' => pay_rate_cents is cents per year. Only hourly staff
            // clock in, which is why the distinction lives this close to auth.
            $table->enum('pay_type', ['hourly', 'salary'])->nullable();
            $table->unsignedBigInteger('pay_rate_cents')->nullable();

            // Self-reference, so deleting a manager doesn't delete their crew.
            $table->foreignId('reports_to')->nullable()
                ->constrained('employees')->nullOnDelete();

            $table->boolean('active')->default(true);
            $table->timestamps();

            $table->index(['active', 'name']);
        });

        Schema::create('password_reset_tokens', function (Blueprint $table) {
            $table->string('email')->primary();
            $table->string('token');
            $table->timestamp('created_at')->nullable();
        });

        Schema::create('sessions', function (Blueprint $table) {
            $table->string('id')->primary();
            $table->foreignId('employee_id')->nullable()->index();
            $table->string('ip_address', 45)->nullable();
            $table->text('user_agent')->nullable();
            $table->longText('payload');
            $table->integer('last_activity')->index();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('sessions');
        Schema::dropIfExists('password_reset_tokens');
        Schema::dropIfExists('employees');
    }
};

import { Model, Table, Column, DataType, PrimaryKey } from "sequelize-typescript";

@Table({
  tableName: "content_cache",
  timestamps: true
})
export class ContentCache extends Model {
    @PrimaryKey
    @Column(DataType.STRING)
    cacheKey!: string; // Unique string hash based on query arguments

    @Column(DataType.INTEGER)
    profileId!: number;

    @Column(DataType.JSON)
    response!: any; // Actual data payloads

    @Column(DataType.DATE)
    expiresAt!: Date;
}